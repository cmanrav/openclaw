import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { setRuntimeConfigSnapshot } from "../../config/io.js";
import * as operationAdmission from "../../infra/sqlite-worker-operation-admission.js";
import {
  openOpenClawStateDatabase,
  type OpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { closeStateDatabaseForTest } from "../../test-utils/database-cleanup.js";
import {
  createWorkerSessionPlacementStore,
  type WorkerSessionPlacementStore,
} from "./placement-store.js";
import { advancePlacementFixtureToActive } from "./placement-test-fixtures.js";

let database: OpenClawStateDatabase;
let placements: WorkerSessionPlacementStore;
let stateDir: string;
const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterAll(async () => {
    await closeStateDatabaseForTest();
    cleanup();
  }),
);

function input(name: string) {
  return {
    sessionId: `placement-worker-${name}`,
    agentId: "main",
    sessionKey: `agent:main:placement-worker-${name}`,
    claimId: `claim-${name}`,
    runId: `run-${name}`,
    owner: { kind: "local" as const },
  };
}

beforeAll(async () => {
  stateDir = tempDirs.make("openclaw-placement-turn-worker-");
  database = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: stateDir } });
  placements = createWorkerSessionPlacementStore({ database, now: () => 1_000 });
  const warm = await placements.claimTurn(input("warm"));
  await placements.releaseTurn(warm);
});

beforeEach(() => setRuntimeConfigSnapshot({}));
afterEach(() => vi.restoreAllMocks());

async function workerClaim(name: string) {
  const requested = input(name);
  const active = await advancePlacementFixtureToActive(placements, database, requested, {
    environmentId: `environment-${name}`,
  });
  return placements.claimTurn({
    ...requested,
    owner: {
      kind: "worker",
      environmentId: active.environmentId,
      ownerEpoch: active.activeOwnerEpoch,
    },
  });
}

it.each(["reclaim", "mutation"] as const)(
  "continues and settles %s workspace custody without caller-thread SQL",
  async (purpose) => {
    const identity = input(`result-${purpose}`);
    const active = await advancePlacementFixtureToActive(
      placements,
      database,
      {
        ...identity,
        executionMode: "remote-exec",
      },
      { environmentId: `result-environment-${purpose}` },
    );
    const claimId = `reclaim-result-${purpose}`;
    const requested = {
      ...identity,
      claimId,
      runId: claimId,
      owner: {
        kind: "local" as const,
        environmentId: active.environmentId,
        ownerEpoch: active.activeOwnerEpoch,
      },
    };
    const queries = observeHostDataSql();
    try {
      const claim =
        purpose === "reclaim"
          ? await placements.claimReclaimWorkspaceResult(requested)
          : await placements.claimWorkspaceMutationResult(requested);
      expect(placements.validateWorkspaceResultClaim(claim)).toBe(true);
      await placements.markWorkspaceResultPending(claim);
      const stagedResultRef = `refs/openclaw/worker-results/${claimId}`;
      await placements.recordStagedWorkspaceResult(claim, stagedResultRef);
      placements.recordWorkspaceResultConflict(claim, { paths: ["conflict.txt"], stagedResultRef });
      expect(await placements.startWorkspaceResultDrain(claim)).toMatchObject({
        state: "draining",
        generation: claim.placementGeneration + 1,
      });
      expect(placements.validateWorkspaceResultClaim(claim)).toBe(true);
      placements.recordWorkspaceResultConflict(claim, undefined);
      await placements.handoffWorkspaceResultRecovery(claim);
      expect(await placements.listPendingWorkspaceResultsAsync(claim.sessionId)).toMatchObject([
        { claimId, recoveryRequestedAtMs: 1_000, workspaceAcceptedAtMs: null },
      ]);
      await placements.acceptWorkspaceResult(claim);
      expect(placements.validateWorkspaceResultClaim(claim)).toBe(true);
      await placements.completeWorkspaceResultAndReleaseTurn(claim);
      expect(placements.validateWorkspaceResultClaim(claim)).toBe(false);
      expect(await placements.listPendingWorkspaceResultsAsync(claim.sessionId)).toEqual([]);
      const cancelled = await placements.claimReclaimWorkspaceResult(requested);
      await placements.cancelWorkspaceResultAndReleaseTurn(cancelled);
      const abandoned = await placements.claimReclaimWorkspaceResult(requested);
      const [pending] = await placements.listPendingWorkspaceResultsAsync(abandoned.sessionId);
      if (!pending) {
        throw new Error("Fixture lost its pending result");
      }
      await placements.abandonWorkspaceResult(pending);
      await placements.releaseTurn(abandoned);
      expect(queries.queries).toEqual([]);
    } finally {
      queries.restore();
    }
  },
);

it("rejects result acceptance when the live caller is revoked before commit", async () => {
  const claim = await workerClaim("result-accept-revoked");
  await placements.markWorkspaceResultPending(claim);
  let revoked = false;
  const createAdmission = operationAdmission.createSqliteWorkerOperationAdmission;
  vi.spyOn(operationAdmission, "createSqliteWorkerOperationAdmission").mockImplementationOnce(
    (admit, attachment) =>
      createAdmission((request, grant) => {
        if (request.stage === "commit") {
          revoked = true;
        }
        admit(request, grant);
      }, attachment),
  );
  await expect(
    placements.acceptWorkspaceResult(claim, () => {
      if (revoked) {
        throw new Error("result caller revoked");
      }
    }),
  ).rejects.toThrow("result caller revoked");
  expect(
    (await placements.listPendingWorkspaceResultsAsync(claim.sessionId))[0]?.workspaceAcceptedAtMs,
  ).toBeNull();
  expect(placements.validateWorkspaceResultClaim(claim)).toBe(true);
  await placements.acceptWorkspaceResult(claim);
  await placements.completeWorkspaceResultAndReleaseTurn(claim);
});

it.each(["prepare", "release"] as const)(
  "keeps the successor result authorized when stale %s does not own it",
  async (operation) => {
    const name = `result-successor-${operation}`;
    const previous = await workerClaim(name);
    await placements.releaseTurn(previous);
    const next = await placements.claimTurn({
      ...input(name),
      claimId: `successor-${operation}`,
      runId: `successor-run-${operation}`,
      owner: previous.owner,
    });
    await placements.markWorkspaceResultPending(next);
    try {
      expect(placements.validateWorkspaceResultClaim(next)).toBe(true);
      if (operation === "prepare") {
        await expect(placements.prepareWorkspaceResultClaim(previous)).rejects.toThrow(
          "workspace result authority changed",
        );
      } else {
        await placements.releaseTurnIfOwned(previous);
      }
      expect(await placements.listPendingWorkspaceResultsAsync(next.sessionId)).toMatchObject([
        { claimId: next.claimId, runId: next.runId },
      ]);
      expect(placements.validateWorkspaceResultClaim(next)).toBe(true);
    } finally {
      await placements.acceptWorkspaceResult(next);
      await placements.completeWorkspaceResultAndReleaseTurn(next);
    }
  },
);
