import { expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import * as sessionAccessor from "../../config/sessions/session-accessor.js";
import { replaceSessionEntrySync } from "../../config/sessions/session-accessor.sqlite-entry.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { rotateAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import { clearAgentRunContext } from "../../infra/agent-run-registry.js";
import * as sessionLifecycle from "../../sessions/session-lifecycle-admission.js";
import { requireOpenClawStateDatabaseIdentity } from "../../state/openclaw-state-db-cache.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { pendingChatSendDedupeKey } from "../server-shared.js";
import { sharingPolicyClient } from "../session-sharing.test-utils.js";
import { createWorkerSessionPlacementStore } from "../worker-environments/placement-store.js";
import { advancePlacementFixtureToActive } from "../worker-environments/placement-test-fixtures.js";
import { stagePlacementTurnClaimWorkerPublication } from "../worker-environments/placement-turn-authority.js";
import { admitChatSend } from "./chat-send-admission.js";
import { normalizeChatSendRequest } from "./chat-send-request.js";
import { prepareChatSendSession, qualifyChatSendSession } from "./chat-send-session.js";

it.each([
  "caller revocation",
  "lifecycle rotation",
  "completed workspace result",
  "new remote placement",
  "retired placement",
  "indeterminate publication",
  "service replacement",
  "unavailable reader",
] as const)("handles %s while preparing placement admission", async (change) => {
  await withOpenClawTestState({ label: "chat-placement-admission" }, async () => {
    const cfg = {
      agents: { ownership: "explicit", entries: { main: {} } },
    } satisfies OpenClawConfig;
    setRuntimeConfigSnapshot(cfg, cfg);
    const sessionKey = "agent:main:dashboard:placement-admission";
    const runId = "chat-placement-admission";
    const scope = { agentId: "main", sessionKey };
    const now = Date.now();
    const entry: SessionEntry = { sessionId: "placement-session", updatedAt: now };
    const accepted =
      change === "completed workspace result" ||
      change === "new remote placement" ||
      change === "retired placement";
    replaceSessionEntrySync(scope, entry);
    if (accepted) {
      await sessionAccessor.appendTranscriptEvent(
        { ...scope, sessionId: entry.sessionId },
        {
          type: "session",
          version: 3,
          id: entry.sessionId,
          timestamp: new Date(now).toISOString(),
          cwd: "/synthetic/workspace",
        },
      );
    }
    const client = sharingPolicyClient({
      scopes: ["operator.admin", "operator.read", "operator.write"],
    });
    const request = await normalizeChatSendRequest({
      client,
      params: { sessionKey, message: "Hello", idempotencyKey: runId },
    });
    if (!request.ok) {
      throw new Error(request.error);
    }
    const database = openOpenClawStateDatabase();
    const placements = createWorkerSessionPlacementStore({ database });
    const completingClaim =
      change === "completed workspace result"
        ? await (async () => {
            const active = await advancePlacementFixtureToActive(placements, database, {
              ...scope,
              sessionId: entry.sessionId,
            });
            const claim = await placements.claimTurn({
              ...scope,
              sessionId: entry.sessionId,
              owner: {
                kind: "worker",
                environmentId: active.environmentId,
                ownerEpoch: active.activeOwnerEpoch,
              },
              claimId: "completed-workspace-claim",
              runId: "completed-workspace-run",
            });
            await placements.markWorkspaceResultPending(claim);
            await placements.acceptWorkspaceResult(claim);
            return claim;
          })()
        : undefined;
    const retiredPlacement =
      change === "retired placement"
        ? await placements.releaseTurn(
            await placements.claimTurn({
              ...scope,
              sessionId: entry.sessionId,
              owner: { kind: "local" },
              claimId: "retired-placement-claim",
              runId: "retired-placement-run",
            }),
          )
        : undefined;
    const getMany = vi.fn(() => new Map());
    const context = createDirectChatContext({
      getRuntimeConfig: () => cfg,
      workerSessionPlacementService: change === "unavailable reader" ? { getMany } : placements,
    });
    const prepared = await prepareChatSendSession({
      isDirectExternalUser: accepted,
      request: request.value,
      client,
      context,
    });
    if (!prepared.ok) {
      throw new Error("Session preparation failed");
    }
    expect(prepared.value.restartSafeRequest).toBeDefined();
    const session = await qualifyChatSendSession(prepared.value);
    const initialEntry = structuredClone(sessionAccessor.loadSessionEntry(scope));
    const observed = createDeferred();
    const resume = createDeferred();
    const preparePlacement = placements.prepareSessionPlacement.bind(placements);
    const delayed = vi
      .spyOn(placements, "prepareSessionPlacement")
      .mockImplementationOnce(async (sessionId) => {
        const facts = await preparePlacement(sessionId);
        observed.resolve();
        await resume.promise;
        return facts;
      });
    const respond = vi.fn();
    let callerCurrent = true;
    let admitted: Awaited<ReturnType<typeof admitChatSend>> | undefined;
    const pending = admitChatSend({
      request: request.value,
      session,
      client,
      context,
      respond,
      assertCurrent: () => {
        if (!callerCurrent) {
          throw new Error("Original chat caller revoked during placement preparation");
        }
      },
    }).then((result) => (admitted = result));
    try {
      if (change !== "unavailable reader") {
        await awaitGateBeforeSettlement(observed.promise, pending, "chat skipped placement facts");
        if (change === "caller revocation") {
          callerCurrent = false;
        } else if (change === "lifecycle rotation") {
          rotateAgentEventLifecycleGeneration();
        } else if (change === "completed workspace result") {
          await placements.completeWorkspaceResultAndReleaseTurn(completingClaim!);
        } else if (change === "new remote placement") {
          await placements.startDispatch({ ...scope, sessionId: entry.sessionId });
        } else if (change === "retired placement") {
          await placements.retireSessionPlacementAsync({
            sessionId: entry.sessionId,
            expectedState: "local",
            expectedGeneration: retiredPlacement!.generation,
          });
        } else if (change === "indeterminate publication") {
          const placement = await placements.startDispatch({
            ...scope,
            sessionId: entry.sessionId,
          });
          stagePlacementTurnClaimWorkerPublication(
            requireOpenClawStateDatabaseIdentity({ db: database.db }),
            placement,
            undefined,
            placement.state,
            placement,
          ).invalidate();
        } else {
          context.workerSessionPlacementService = createWorkerSessionPlacementStore();
        }
        resume.resolve();
      }
      const result = await pending;
      expect(result.ok).toBe(accepted);
      if (accepted && result.ok) {
        expect(respond).not.toHaveBeenCalled();
        expect(context.chatAbortControllers.size).toBe(1);
        expect(Boolean(result.value.restartSafeAdmission)).toBe(change === "retired placement");
      } else {
        expect(respond).toHaveBeenCalledOnce();
        expect(context.chatAbortControllers.size).toBe(0);
      }
      expect(context.dedupe.has(pendingChatSendDedupeKey(runId))).toBe(false);
      expect(sessionAccessor.loadSessionEntry(scope)).toEqual(initialEntry);
      if (!accepted) {
        expect(
          sessionLifecycle.getSessionWorkAdmissionRelease({
            scope: session.storePath,
            identities: [sessionKey, entry.sessionId],
          }),
        ).toBeUndefined();
      }
      if (change === "unavailable reader") {
        expect(respond.mock.calls[0]?.[2]?.message).toContain(
          "Worker placement admission reader is unavailable",
        );
        expect(getMany).not.toHaveBeenCalled();
      } else if (change === "caller revocation") {
        expect(respond.mock.calls[0]?.[2]?.message).toContain(
          "Original chat caller revoked during placement preparation",
        );
      }
    } finally {
      resume.resolve();
      await Promise.allSettled([pending]);
      delayed.mockRestore();
      if (admitted?.ok) {
        admitted.value.cleanupAdmittedRun();
      }
      clearAgentRunContext(runId);
    }
    expect(context.chatAbortControllers.size).toBe(0);
    expect(
      sessionLifecycle.getSessionWorkAdmissionRelease({
        scope: session.storePath,
        identities: [sessionKey, entry.sessionId],
      }),
    ).toBeUndefined();
    if (admitted?.ok) {
      expect(admitted.value.gatewayWorkAdmission.isActive()).toBe(false);
    }
  });
});

it.each([
  {
    name: "ineligible internal backend",
    external: false,
    initialRequired: false,
    required: false,
    allowed: true,
    reloadDuringRead: false,
  },
  {
    name: "required-profile external backend",
    external: true,
    initialRequired: true,
    required: true,
    allowed: true,
    reloadDuringRead: false,
  },
  {
    name: "local-to-required policy reload",
    external: true,
    initialRequired: false,
    required: true,
    allowed: true,
    reloadDuringRead: false,
  },
  {
    name: "local-to-required during placement preparation",
    external: true,
    initialRequired: false,
    required: true,
    allowed: true,
    reloadDuringRead: true,
  },
  {
    name: "required-to-local policy reload",
    external: true,
    initialRequired: true,
    required: false,
    allowed: false,
    reloadDuringRead: false,
  },
])("preserves pending placement fences for $name", async (testCase) => {
  await withOpenClawTestState({ label: "backend-chat-pending-placement" }, async () => {
    let cfg: OpenClawConfig = {
      agents: { ownership: "explicit", entries: { main: {} } },
      ...(testCase.initialRequired ? { cloudWorkers: { requiredProfile: "native" } } : {}),
    };
    setRuntimeConfigSnapshot(cfg, cfg);
    const scope = {
      agentId: "main",
      sessionKey: "agent:main:backend-pending-placement",
      sessionId: "backend-pending-placement",
    };
    const runId = "backend-pending-placement-send";
    replaceSessionEntrySync(scope, { sessionId: scope.sessionId, updatedAt: 1 });
    const placements = createWorkerSessionPlacementStore();
    const requested = await placements.startDispatch(scope);
    const client = sharingPolicyClient({
      scopes: ["operator.admin", "operator.read", "operator.write"],
    });
    client.connect.client = {
      id: "gateway-client",
      version: "test",
      platform: "test",
      mode: "backend",
    };
    const context = createDirectChatContext({
      getRuntimeConfig: () => cfg,
      workerSessionPlacementService: placements,
    });
    const request = await normalizeChatSendRequest({
      client,
      params: { sessionKey: scope.sessionKey, message: "Hello", idempotencyKey: runId },
    });
    if (!request.ok) {
      throw new Error(request.error);
    }
    const prepared = await prepareChatSendSession({
      request: request.value,
      client,
      context,
      isDirectExternalUser: testCase.external,
    });
    if (!prepared.ok) {
      throw new Error("Session preparation failed");
    }
    expect(Boolean(prepared.value.restartSafeRequest)).toBe(testCase.external);
    const session = await qualifyChatSendSession(prepared.value);
    const reloadPolicy = () => {
      cfg = {
        ...cfg,
        cloudWorkers: testCase.required ? { requiredProfile: "native" } : undefined,
      };
      setRuntimeConfigSnapshot(cfg, cfg);
    };
    if (testCase.required !== testCase.initialRequired && !testCase.reloadDuringRead) {
      reloadPolicy();
    }
    const read = await placements.prepareSessionPlacement(scope.sessionId);
    const pending = stagePlacementTurnClaimWorkerPublication(
      requireOpenClawStateDatabaseIdentity({ db: openOpenClawStateDatabase().db }),
      requested,
      undefined,
      requested.state,
      requested,
    );
    const preparePlacement = placements.prepareSessionPlacement.bind(placements);
    const reloadingRead = testCase.reloadDuringRead
      ? vi
          .spyOn(placements, "prepareSessionPlacement")
          .mockImplementationOnce(async (sessionId) => {
            const facts = await preparePlacement(sessionId);
            reloadPolicy();
            return facts;
          })
      : undefined;
    const respond = vi.fn();
    let admitted: Awaited<ReturnType<typeof admitChatSend>> | undefined;
    try {
      expect(() => read.current()).toThrow("placement authority changed");
      admitted = await admitChatSend({
        request: request.value,
        session,
        client,
        context,
        respond,
      });
      expect(admitted.ok, JSON.stringify(respond.mock.calls)).toBe(testCase.allowed);
      expect(context.chatAbortControllers.has(runId)).toBe(testCase.allowed);
      if (!testCase.allowed) {
        expect(respond.mock.calls[0]?.[2]?.message).toContain("placement authority changed");
      }
      expect(() => read.current()).toThrow("placement authority changed");
    } finally {
      reloadingRead?.mockRestore();
      pending.rollback();
      read.release();
      if (admitted?.ok) {
        admitted.value.cleanupAdmittedRun();
      }
      clearAgentRunContext(runId);
    }
  });
});
