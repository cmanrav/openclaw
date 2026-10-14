// Restart-path proof against the real registry sweeper and SQLite session store.
import { describe, expect, it, vi } from "vitest";
// Preserve module setup before modules that consume it.
// oxfmt-ignore
import { makeRestartRecoveryRun as makeRunRecord, useSubagentRestartRecoveryFixture } from "./subagent-restart-recovery.test-support.js";
import {
  getAgentEventLifecycleGeneration,
  rotateAgentEventLifecycleGeneration,
} from "../../../infra/agent-events.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import { loadSubagentRegistryFromSqlite } from "./subagent-registry-state.fixture.test-support.js";
import {
  readSubagentSessionStore,
  writeSubagentSessionEntry,
} from "./subagent-registry.persistence.test-support.js";
import {
  addSubagentRunForTests,
  initSubagentRegistry,
  listSubagentRunsForRequester,
  resetSubagentRegistryForTests,
  testing,
} from "./subagent-registry.test-helpers.js";

// mock-isolation: Restart-marker fixtures use empty synthetic transcripts without opening filesystem histories.
vi.mock("../../../gateway/session-utils.fs.js", () => ({
  readSessionMessagesAsync: vi.fn(async () => []),
}));

describe("subagent orphan recovery — predecessor generations", () => {
  const fixture = useSubagentRestartRecoveryFixture();
  const { activateGatewayRuntime, dispatchAgent } = fixture;
  it("preserves a newer restart marker when cold-restoring a retired accepted receipt", async () => {
    const now = Date.now();
    const childSessionKey = "agent:main:subagent:retired-accepted";
    const runId = "run-retired-accepted";
    const priorLifecycleGeneration = getAgentEventLifecycleGeneration();
    const storePath = await writeSubagentSessionEntry({
      stateDir: fixture.stateDir,
      agentId: "main",
      sessionKey: childSessionKey,
      sessionId: "sess-retired-accepted",
      updatedAt: now,
      abortedLastRun: true,
      defaultSessionId: "sess-retired-accepted",
    });
    const record = makeRunRecord({
      runId,
      childSessionKey,
      childSessionIdentity: { sessionId: "sess-retired-accepted" },
      generation: 1,
      createdAt: now - 60_000,
      startedAt: now - 55_000,
      execution: {
        status: "interrupted",
        startedAt: now - 55_000,
        restartRecovery: {
          sessionId: "sess-retired-accepted",
          sessionMarker: "sess-retired-accepted:1",
          idempotencyKey: "subagent-recovery:retired-accepted",
          phase: "accepted",
          lifecycleGeneration: priorLifecycleGeneration,
        },
      },
    });
    await addSubagentRunForTests(record);

    await fixture.settle();
    await resetSubagentRegistryForTests({ persist: false });
    rotateAgentEventLifecycleGeneration();
    await initSubagentRegistry();
    await activateGatewayRuntime();
    await fixture.settle();
    await testing.sweepOnceForTests();

    expect(dispatchAgent).not.toHaveBeenCalled();
    expect(subagentRuns.get(runId)).toMatchObject({
      execution: {
        status: "terminal",
        outcome: {
          status: "error",
          error: expect.stringContaining("Gateway restart"),
        },
      },
    });
    await fixture.settle();
    expect((await readSubagentSessionStore(storePath))[childSessionKey]).toMatchObject({
      abortedLastRun: true,
    });
    const persisted = loadSubagentRegistryFromSqlite().get(runId);
    expect(persisted).toMatchObject({
      execution: {
        status: "terminal",
        suppressSessionEffects: true,
      },
    });
    expect(persisted?.execution.restartRecovery).toBeUndefined();

    await resetSubagentRegistryForTests({ persist: false });
    rotateAgentEventLifecycleGeneration();
    await initSubagentRegistry();
    await activateGatewayRuntime();
    await fixture.settle();
    await testing.sweepOnceForTests();

    const restoredAgain = subagentRuns.get(runId);
    expect(restoredAgain).toMatchObject({
      execution: {
        status: "terminal",
        suppressSessionEffects: true,
      },
    });
    await fixture.settle();
    expect(restoredAgain?.execution.restartRecovery).toBeUndefined();
    expect((await readSubagentSessionStore(storePath))[childSessionKey]).toMatchObject({
      abortedLastRun: true,
    });
  });

  it("finalizes only a stale predecessor when a fresh generation shares its child session", async () => {
    const now = Date.now();
    const childSessionKey = "agent:main:subagent:shared-generation";
    const staleRecord = makeRunRecord({
      runId: "run-stale-generation",
      childSessionKey,
      childSessionIdentity: { sessionId: "sess-shared-generation" },
      generation: 1,
      createdAt: now - 3 * 60 * 60 * 1_000,
      startedAt: now - 3 * 60 * 60 * 1_000,
      sessionStartedAt: now - 3 * 60 * 60 * 1_000,
    });
    const freshRecord = makeRunRecord({
      runId: "run-fresh-generation",
      childSessionKey,
      childSessionIdentity: { sessionId: "sess-shared-generation" },
      generation: 2,
      createdAt: now - 60_000,
      startedAt: now - 55_000,
      sessionStartedAt: now - 60_000,
    });
    await addSubagentRunForTests(staleRecord);
    await addSubagentRunForTests(freshRecord);

    await writeSubagentSessionEntry({
      stateDir: fixture.stateDir,
      agentId: "main",
      sessionKey: childSessionKey,
      sessionId: "sess-shared-generation",
      updatedAt: now,
      abortedLastRun: true,
      defaultSessionId: "sess-shared-generation",
    });
    await testing.sweepOnceForTests();

    const runs = listSubagentRunsForRequester("agent:main:main");
    expect(dispatchAgent).not.toHaveBeenCalled();
    expect(runs.some((entry) => entry.runId === staleRecord.runId)).toBe(false);
    expect(runs).toContainEqual(
      expect.objectContaining({
        runId: freshRecord.runId,
        execution: expect.objectContaining({ status: "terminal" }),
      }),
    );
  });
});
