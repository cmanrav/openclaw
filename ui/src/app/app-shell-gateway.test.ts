/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UI_APPEARANCE_PREFERENCE_KEYS } from "../../../packages/gateway-protocol/src/schema/ui-appearance-preferences.ts";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import { createGatewayHarness } from "../lib/config/config-test-harness.ts";
import { createRuntimeConfigCapability } from "../lib/config/runtime-config-capability.ts";
import { createStorageMock } from "../test-helpers/storage.ts";
import { createProfileAppearanceGateway } from "./app-shell-gateway.test-support.ts";
import { createGatewayMetadataObserver } from "./gateway-observers.ts";
import { UI_NAVIGATION_PREFERENCE_KEYS } from "./server-prefs-state.ts";
import { pushServerUiPrefs, resetServerUiPrefsSync } from "./server-prefs.ts";
import { loadSettings, patchSettings } from "./settings.ts";

describe("ShellGatewayOwner profile appearance integration", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", createStorageMock());
    resetServerUiPrefsSync();
  });

  afterEach(() => {
    resetServerUiPrefsSync();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("replays offline preferences when hello precedes the config owner's connection publication", async () => {
    let config = { ui: { prefs: { accent: "#112233" } } };
    const request = vi.fn(async (method: string, params?: unknown) => {
      if (method === "config.patch") {
        config = JSON.parse((params as { raw: string }).raw);
        return { config, hash: "patched" };
      }
      return { config, raw: JSON.stringify(config), hash: "initial", valid: true, issues: [] };
    });
    const { context, owner, snapshot } = createProfileAppearanceGateway(null);
    const client = { gatewayUrl: "ws://profile.test", request } as unknown as GatewayBrowserClient;
    const { gateway, publish } = createGatewayHarness(client);
    publish(false);
    // Shell listeners can observe hello before the config owner adopts its transport.
    const stopGateway = gateway.subscribe((next) => {
      Object.assign(snapshot, next);
      void owner.ensureRuntimeConfig(snapshot, context.runtimeConfig);
    });
    const runtimeConfig = createRuntimeConfigCapability(gateway);
    Object.assign(context, { runtimeConfig });
    const stopConfig = runtimeConfig.subscribe(() => {
      void owner.ensureRuntimeConfig(snapshot, runtimeConfig);
    });
    try {
      pushServerUiPrefs(runtimeConfig, { accent: "#336699" });
      publish(true);
      await vi.dynamicImportSettled();
      await owner.ensureRuntimeConfig(snapshot, runtimeConfig);
      expect(request.mock.calls.filter(([method]) => method === "config.patch")).toEqual([
        [
          "config.patch",
          {
            raw: JSON.stringify({ ui: { prefs: { accent: "#336699" } } }),
            note: "control-ui prefs sync",
          },
        ],
      ]);
      expect(config.ui.prefs.accent).toBe("#336699");
    } finally {
      stopConfig();
      stopGateway();
      runtimeConfig.dispose();
    }
  });

  it.each(["context", "client", "profile", "config", "source", "offline", "reset"])(
    "discards lazy reconciliation after %s replacement",
    async (replacement) => {
      const { context, host, owner, snapshot, refreshTheme, request } =
        createProfileAppearanceGateway(null);
      patchSettings({ accent: "#112233" });
      const pending = owner.reconcileServerUiPrefs(context.runtimeConfig);
      if (replacement === "context") {
        Object.assign(host, { context: { ...context } });
      }
      if (replacement === "client") {
        snapshot.client = createProfileAppearanceGateway(null).snapshot.client;
      }
      if (replacement === "profile") {
        snapshot.selfUser = { id: "replacement" };
      }
      if (replacement === "config") {
        Object.assign(context.runtimeConfig.state, { configSnapshot: { config: {} } });
      }
      if (replacement === "source") {
        Object.assign(context, { runtimeConfig: { ...context.runtimeConfig } });
      }
      if (replacement === "offline") {
        snapshot.phase = "offline";
      }
      if (replacement === "reset") {
        owner.reset();
      }
      await pending;
      expect(loadSettings().accent).toBe("#112233");
      expect(refreshTheme).not.toHaveBeenCalled();
      expect(request).not.toHaveBeenCalled();
      expect(host.lastLocalePrefSignature).toBeNull();
    },
  );

  it.each(["bootstrap", "invalidation"])(
    "keeps %s and deduplicated callers pending through actual profile hydration",
    async (entry) => {
      const { context, owner, snapshot, request } = createProfileAppearanceGateway("profile-owner");
      const readStarted = createDeferred();
      const reply = createDeferred<{
        status: string;
        entries: { "ui.accent": string; "ui.railShortcuts": string[] };
      }>();
      request.mockImplementationOnce(() => {
        readStarted.resolve();
        return reply.promise;
      });
      if (entry === "invalidation") {
        owner.handleGatewayEvent({
          type: "event",
          event: "users.prefs.changed",
          payload: { profileId: "profile-owner", keys: ["ui.accent"] },
        });
        await readStarted.promise;
      }
      const ready =
        entry === "bootstrap"
          ? owner.ensureRuntimeConfig(snapshot, context.runtimeConfig)
          : owner.reconcileServerUiPrefs(context.runtimeConfig);
      if (entry === "bootstrap") {
        expect(owner.ensureRuntimeConfig(snapshot, context.runtimeConfig)).toBe(ready);
      }
      let complete = false;
      void ready.then(() => {
        complete = true;
      });
      await readStarted.promise;
      expect(complete).toBe(false);
      reply.resolve({ status: "ok", entries: { "ui.accent": "#336699", "ui.railShortcuts": [] } });
      await vi.dynamicImportSettled();
      expect(request).toHaveBeenCalledOnce();
      await ready;
      expect(complete).toBe(true);
      expect(loadSettings().accent).toBe("#336699");
      await owner.reconcileServerUiPrefs(context.runtimeConfig);
      expect(request).toHaveBeenCalledOnce();
    },
  );

  it("reconciles a profile read retired by a theme commit without reusing its pending source", async () => {
    const { context, owner, snapshot } = createProfileAppearanceGateway("profile-owner");
    const writeStarted = createDeferred();
    const writeReply = createDeferred<unknown>();
    const readStarted = createDeferred();
    const readReply = createDeferred<unknown>();
    const commitStarted = createDeferred();
    let reconciliation: Promise<void> | undefined;
    let reads = 0;
    const request = vi.fn(async (method: string) => {
      if (method === "themes.set") {
        writeStarted.resolve();
        return writeReply.promise;
      }
      expect(method).toBe("users.prefs.get");
      reads += 1;
      if (reads === 2) {
        readStarted.resolve();
        return readReply.promise;
      }
      return {
        status: "ok",
        entries: {
          "ui.accent": reads === 1 ? "#336699" : "#22c55e",
          "ui.themeMode": reads === 1 ? "dark" : "light",
          "ui.railShortcuts": [],
        },
      };
    });
    Object.assign(snapshot.client!, { request });
    await owner.ensureRuntimeConfig(snapshot, context.runtimeConfig);
    patchSettings({ themeMode: "light" });
    pushServerUiPrefs(
      context.runtimeConfig,
      { themeMode: "light" },
      {
        profileId: "profile-owner",
        canWrite: true,
        afterCommit: () => {
          reconciliation = owner.reconcileCommittedServerUiPrefs(context.runtimeConfig, false);
          commitStarted.resolve();
        },
      },
    );
    await writeStarted.promise;
    // themes.set publishes its committed invalidation before acknowledging the write.
    owner.handleGatewayEvent({
      type: "event",
      event: "users.prefs.changed",
      payload: { profileId: "profile-owner", keys: ["ui.themeMode"] },
    });
    await readStarted.promise;
    writeReply.resolve({ application: "saved" });
    await commitStarted.promise;
    readReply.resolve({
      status: "ok",
      entries: { "ui.accent": "#ff0000", "ui.themeMode": "light", "ui.railShortcuts": [] },
    });
    await reconciliation;
    expect(loadSettings()).toMatchObject({ accent: "#22c55e", themeMode: "light" });
  });

  it("reads fresh profile appearance after reconnecting with the same client", async () => {
    const { context, owner, snapshot, request } = createProfileAppearanceGateway("profile-owner");
    request.mockResolvedValue({
      status: "ok",
      entries: { "ui.accent": "#336699", "ui.railShortcuts": [] },
    });
    owner.synchronizeGateway(snapshot);
    await owner.ensureRuntimeConfig(snapshot, context.runtimeConfig);
    expect(loadSettings().accent).toBe("#336699");

    const connected = { ...snapshot };
    snapshot.phase = "reconnecting";
    createGatewayMetadataObserver(() => true).synchronize(connected, snapshot);
    owner.synchronizeGateway(snapshot);
    request.mockResolvedValue({
      status: "ok",
      entries: { "ui.accent": "#445566", "ui.railShortcuts": [] },
    });
    snapshot.phase = "connected";
    owner.synchronizeGateway(snapshot);
    await owner.ensureRuntimeConfig(snapshot, context.runtimeConfig);
    expect(loadSettings().accent).toBe("#445566");
  });

  it("refuses profile hydration from a superseded config snapshot", async () => {
    const { context, owner, snapshot, request, refreshTheme, requestUpdate } =
      createProfileAppearanceGateway("profile-owner");
    const readStarted = createDeferred();
    const reply = createDeferred<{
      status: string;
      entries: { "ui.accent": string; "ui.railShortcuts": string[] };
    }>();
    request.mockImplementationOnce(() => {
      readStarted.resolve();
      return reply.promise;
    });
    const ready = owner.ensureRuntimeConfig(snapshot, context.runtimeConfig);
    await readStarted.promise;
    // Initial identity adoption published its navigation reset before the held profile read.
    expect(refreshTheme).toHaveBeenCalledOnce();
    refreshTheme.mockClear();
    Object.assign(context.runtimeConfig.state, { configSnapshot: { config: {} } });
    reply.resolve({ status: "ok", entries: { "ui.accent": "#336699", "ui.railShortcuts": [] } });
    await ready;
    expect(loadSettings().accent).not.toBe("#336699");
    expect(refreshTheme).not.toHaveBeenCalled();
    expect(requestUpdate).not.toHaveBeenCalled();
  });

  it("loads current agent discovery when hello lands", async () => {
    const { context, host, owner, snapshot } = createProfileAppearanceGateway(null);
    const agentsList = {
      defaultId: "main",
      mainKey: "main",
      scope: "per-sender" as const,
      agents: [{ id: "main" }],
    };
    const ensureList = vi.fn(async () => agentsList);
    Object.assign(context, {
      agents: { state: { agentsList: null }, ensureList },
    });
    host.routeState.routeId = "chat";

    owner.synchronizeGateway(snapshot);
    await Promise.resolve();

    expect(ensureList).toHaveBeenCalledOnce();
  });

  it.each([false, true])(
    "loads and caches profile appearance (matching browser mirror: %s)",
    async (mirrored) => {
      if (mirrored) {
        patchSettings({ gatewayUrl: "ws://profile.test", accent: "#336699" });
      }
      const {
        completeProfileAppearance,
        context,
        owner,
        refreshTheme,
        requestUpdate,
        request,
        snapshot,
      } = createProfileAppearanceGateway(mirrored ? "profile-owner" : null);
      owner.synchronizeGateway(snapshot);
      if (!mirrored) {
        owner.handleGatewayEvent({
          type: "event",
          event: "users.prefs.changed",
          payload: { profileId: "someone-else", keys: ["ui.accent"] },
        });
        expect(request).not.toHaveBeenCalled();
        snapshot.selfUser = { id: "profile-owner" };
        owner.synchronizeGateway(snapshot);
        void owner.reconcileServerUiPrefs(context.runtimeConfig);
        expect(refreshTheme).not.toHaveBeenCalled();
        expect(loadSettings().accent).toBeUndefined();
      }
      await completeProfileAppearance();
      await vi.dynamicImportSettled();
      // Adoption publishes navigation, then hydration publishes profile/readiness.
      expect(refreshTheme).toHaveBeenCalledTimes(2);
      expect(requestUpdate).toHaveBeenCalledOnce();
      expect(refreshTheme).toHaveBeenCalledWith({ notify: true });
      expect(loadSettings().accent).toBe("#336699");
      expect(request).toHaveBeenCalledExactlyOnceWith("users.prefs.get", {
        keys: [
          ...Object.values(UI_APPEARANCE_PREFERENCE_KEYS),
          ...Object.values(UI_NAVIGATION_PREFERENCE_KEYS),
        ],
      });
      request.mockClear();
      const configState = context.runtimeConfig.state as { configSnapshot: { config: unknown } };
      configState.configSnapshot = {
        config: { ui: { prefs: { accent: "#884422" } }, agents: { defaults: {} } },
      };
      await owner.reconcileServerUiPrefs(context.runtimeConfig);
      expect(request).not.toHaveBeenCalled();
      expect(loadSettings().accent).toBe("#336699");
    },
  );

  it.each(["profile-owner", "canonical-owner"])(
    "refreshes current profile appearance for its routed %s invalidation",
    async (eventProfileId) => {
      const { completeProfileAppearance, owner, refreshTheme, request, snapshot } =
        createProfileAppearanceGateway("profile-owner");
      owner.synchronizeGateway(snapshot);
      await completeProfileAppearance();
      expect(loadSettings().accent).toBe("#336699");
      request.mockClear();
      refreshTheme.mockClear();

      owner.handleGatewayEvent({
        type: "event",
        event: "users.prefs.changed",
        payload: {
          profileId: eventProfileId,
          keys: ["ui.accent"],
          entries: { "ui.accent": "#ffffff" },
        },
      });

      expect(loadSettings().accent).toBe("#336699");
      await completeProfileAppearance("#224466");
      expect(loadSettings().accent).toBe("#224466");
      expect(request).toHaveBeenCalledOnce();
      expect(refreshTheme).toHaveBeenCalledOnce();
    },
  );
});
