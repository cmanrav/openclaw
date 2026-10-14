import type { AgentHarnessAttemptParamsV2 } from "openclaw/plugin-sdk/agent-harness-runtime";
import * as harnessRuntime from "openclaw/plugin-sdk/agent-harness-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/plugin-entry";
import { createPluginStateKeyedStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { withOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { Type } from "typebox";
import { expect, it, vi } from "vitest";
import type { AgentsApiBinding } from "./agentsapi-bindings.js";
import { AgentsApiClient } from "./agentsapi-client.js";
import {
  createAttempt,
  registerHarness,
  mockClient,
  reopenState,
} from "./agentsapi-harness.persistence.test-helpers.js";
import { createHostedSession } from "./agentsapi.test-support.js";

/** Uses the parent persistence suite's mocked transport and cleanup lifecycle. */
export function registerForwardingTests(
  fetchWithSsrFGuardMock: ReturnType<
    typeof vi.fn<typeof import("openclaw/plugin-sdk/ssrf-runtime").fetchWithSsrFGuard>
  >,
) {
  it.each([
    { name: "defaults", forwarding: undefined, gateway: true, mcp: true },
    {
      name: "Gateway only disabled",
      forwarding: { gatewayTools: false },
      gateway: false,
      mcp: true,
    },
    { name: "MCP only disabled", forwarding: { mcpServers: false }, gateway: true, mcp: false },
    {
      name: "all forwarding disabled",
      forwarding: { gatewayTools: false, mcpServers: false },
      gateway: false,
      mcp: false,
    },
  ])("sends only enabled forwarding surfaces with $name", async ({ forwarding, gateway, mcp }) => {
    await withOpenClawTestState({ label: "agentsapi-forwarding-request" }, async (state) => {
      const params = await createAttempt(state.stateDir);
      const client = mockClient("session-fixture");
      // Exercise the official SDK's serialized create request, not a preassembled tool list.
      client.create.mockRestore();
      const requests: unknown[] = [];
      fetchWithSsrFGuardMock.mockImplementation(async ({ url, init, beforeRequest }) => {
        beforeRequest?.();
        expect(new URL(url).pathname).toBe("/v1/agents/sessions");
        requests.push(await new Request(url, init).json());
        return {
          response: Response.json({ id: "session-fixture" }),
          finalUrl: url,
          release: async () => {},
        };
      });
      const construct = vi.fn<
        NonNullable<AgentHarnessAttemptParamsV2["hostCapabilities"]["createToolSurfaceAsync"]>
      >(async () => {
        if (!gateway) {
          throw new Error("Disabled Gateway tools must not be constructed");
        }
        return [
          {
            name: "fixture_gateway",
            label: "Fixture Gateway tool",
            description: "Fixture Gateway function",
            parameters: Type.Object({}, { additionalProperties: false }),
            execute: async () => ({
              content: [{ type: "text", text: "Fixture result" }],
              details: {},
            }),
          },
        ];
      });
      const loadMcp = vi.spyOn(harnessRuntime, "loadAgentHarnessMcpConfig");
      if (!mcp) {
        loadMcp.mockRejectedValue(new Error("Disabled MCP discovery must not resolve credentials"));
      }
      vi.stubEnv("AGENTSAPI_FORWARDING_TEST_MISSING", undefined);
      const config: OpenClawConfig = {
        plugins: { enabled: false },
        mcp: {
          servers: {
            fixture: {
              transport: "streamable-http",
              url: "https://mcp.example.test/mcp",
              headers: {
                Authorization: mcp
                  ? "Bearer fixture-token"
                  : "Bearer ${AGENTSAPI_FORWARDING_TEST_MISSING}",
              },
            },
          },
        },
      };
      const harness = registerHarness(state.env, () => ({
        plugins: { entries: { agentsapi: { config: { forwarding } } } },
      }));
      try {
        const run = (runId: string) =>
          harness.runAttempt({
            ...params,
            config,
            runId,
            // Match the native-only allowlist that does not itself disable MCP forwarding.
            ...(!gateway && !mcp
              ? {
                  toolsAllow: [
                    "exec",
                    "process",
                    "read",
                    "write",
                    "edit",
                    "apply_patch",
                    "web_search",
                  ],
                }
              : {}),
            hostCapabilities: { ...params.hostCapabilities, createToolSurfaceAsync: construct },
          });
        expect(await run("first-forwarding-run")).toMatchObject({ terminal: { kind: "ok" } });
        expect(requests).toHaveLength(1);
        expect(requests[0]).toMatchObject({
          agent: {
            tools: [
              { type: "web_search", mode: "live" },
              { type: "programmatic_tool_calling", enabled: true },
              ...(mcp
                ? [
                    {
                      type: "mcp",
                      server_label: "fixture",
                      transport: {
                        type: "http",
                        server_url: "https://mcp.example.test/mcp",
                        headers: { Authorization: "Bearer fixture-token" },
                      },
                      connection_origin: "environment",
                    },
                  ]
                : []),
              ...(gateway ? [{ type: "function", name: "fixture_gateway" }] : []),
            ],
          },
          environment: { type: "openai_hosted", files: [] },
        });
        if (!mcp) {
          config.mcp!.servers!.future = {
            transport: "streamable-http",
            url: "https://future.example.test/mcp",
          };
        }
        expect(await run("followup-forwarding-run")).toMatchObject({ terminal: { kind: "ok" } });
        expect(requests).toHaveLength(1);
        expect(client.message.mock.calls.map(([sessionId]) => sessionId)).toEqual([
          "session-fixture",
          "session-fixture",
        ]);
        expect(construct).toHaveBeenCalledTimes(gateway ? 2 : 0);
        expect(loadMcp).toHaveBeenCalledTimes(mcp ? 2 : 0);
      } finally {
        await harness.dispose();
      }
    });
  });

  it("retains immutable forwarding bindings across policy changes and permits explicit reset", async () => {
    await withOpenClawTestState({ label: "agentsapi-forwarding-reset" }, async (state) => {
      const params = await createAttempt(state.stateDir);
      const openStore = () =>
        createPluginStateKeyedStoreForTests<AgentsApiBinding>("agentsapi", {
          namespace: "agentsapi-sessions",
          maxEntries: 100_000,
          overflowPolicy: "reject-new",
          env: state.env,
        });
      const original = {
        sessionId: "original-native-session",
        configFingerprint: "7279f68deebd4e52eb136c95ccbb8c642a7f141b836a33de22c8aa9a4a93c022",
      };
      await openStore().register(params.sessionId, original);
      const client = mockClient("isolated-native-session");
      const cancel = vi.spyOn(AgentsApiClient.prototype, "cancel").mockResolvedValue();
      let forwarding = { gatewayTools: true, mcpServers: true };
      const register = () =>
        registerHarness(state.env, () => ({
          plugins: { entries: { agentsapi: { config: { forwarding } } } },
        }));
      let harness = register();
      try {
        // Explicit defaults must still accept the exact pre-policy persisted identity.
        expect(await harness.runAttempt(params)).toMatchObject({ terminal: { kind: "ok" } });
        for (const restricted of [
          { gatewayTools: false, mcpServers: true },
          { gatewayTools: true, mcpServers: false },
          { gatewayTools: false, mcpServers: false },
        ]) {
          forwarding = restricted;
          expect(await harness.runAttempt(params)).toMatchObject({
            terminal: {
              kind: "failed",
              error: expect.objectContaining({
                message: expect.stringContaining(
                  "forwarding policy changed; reset the OpenClaw session",
                ),
              }),
            },
          });
          expect(await openStore().lookup(params.sessionId)).toEqual(original);
        }
        expect(client.create).not.toHaveBeenCalled();
        expect(client.update).toHaveBeenCalledTimes(1);
        expect(client.message).toHaveBeenCalledTimes(1);
        // Cleanup must still work after restart, without accepting the new policy for resume.
        await harness.dispose();
        await reopenState();
        harness = register();
        client.session.mockResolvedValue({
          ...createHostedSession("in_progress"),
          id: original.sessionId,
        });
        await harness.reset({ ...params.sessionTarget, reason: "reset" });
        expect(cancel).toHaveBeenCalledExactlyOnceWith(original.sessionId, expect.any(AbortSignal));
        expect(await harness.runAttempt(params)).toMatchObject({ terminal: { kind: "ok" } });
        const isolated = await openStore().lookup(params.sessionId);
        expect(isolated).toMatchObject({ sessionId: "isolated-native-session" });
        expect(isolated?.configFingerprint).not.toBe(original.configFingerprint);
        forwarding = { gatewayTools: true, mcpServers: true };
        expect(await harness.runAttempt(params)).toMatchObject({
          terminal: {
            kind: "failed",
            error: expect.objectContaining({
              message: expect.stringContaining(
                "forwarding policy changed; reset the OpenClaw session",
              ),
            }),
          },
        });
        expect(await openStore().lookup(params.sessionId)).toEqual(isolated);
        expect(client.create).toHaveBeenCalledTimes(1);
        expect(client.message).toHaveBeenCalledTimes(2);
      } finally {
        await harness.dispose();
      }
    });
  });
}
