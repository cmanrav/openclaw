import { expect, it, vi } from "vitest";
import { trackSqliteStatementExecutions } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { readSqliteDatabaseWriteRevision } from "../../infra/sqlite-database-admission.js";
import { runWithSqliteWorkerStateContext } from "../../infra/sqlite-worker-state-context.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { maintainCronRunHistoryInWorker } from "./runtime-maintenance.worker.js";

it.each(["empty", "retained", "expired"] as const)(
  "does not invalidate shared readers unless history maintenance changes rows: %s",
  async (history) => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "cron-history-no-recovery-" },
      async (state) => {
        const database = openOpenClawStateDatabase();
        const day = 24 * 60 * 60_000;
        const nowMs = 10 * day;
        if (history !== "empty") {
          const endedAt = nowMs - (history === "expired" ? 8 : 1) * day;
          database.db
            .prepare(
              "INSERT INTO task_runs (task_id, runtime, source_id, owner_key, scope_kind, task, delivery_status, notify_policy, created_at, ended_at, status) VALUES ('terminal', 'cron', 'job', '', 'system', 'legacy', 'not_applicable', 'silent', ?, ?, 'succeeded')",
            )
            .run(endedAt, endedAt);
        }
        const revision = readSqliteDatabaseWriteRevision(database.db);
        expect(revision).toBeTypeOf("number");
        const exec = vi.spyOn(database.db, "exec");
        const reads = trackSqliteStatementExecutions(
          database.db,
          ["history", "receipts"],
          (sql) => {
            if (!/^select\b/i.test(sql)) {
              return null;
            }
            if (sql.includes('from "cron_run_receipts"')) {
              return "receipts";
            }
            return sql.includes('from "task_runs"') ? "history" : null;
          },
        );
        try {
          const result = runWithSqliteWorkerStateContext(
            { environment: { OPENCLAW_STATE_DIR: state.stateDir } },
            () =>
              maintainCronRunHistoryInWorker(database, {
                snapshot: {
                  nowMs,
                  protectedJobIds: [],
                },
              }),
          );
          expect(result).toEqual({
            outcome: {
              reconciled: 0,
              pruned: history === "expired" ? 1 : 0,
              nextSweepAtMs: history === "retained" ? nowMs + 6 * day : null,
            },
          });
          expect(reads.counts).toEqual({ history: 1, receipts: 0 });
          expect(exec.mock.calls.some(([sql]) => /^\s*BEGIN\b/i.test(sql))).toBe(
            history === "expired",
          );
          if (history === "expired") {
            expect(readSqliteDatabaseWriteRevision(database.db)).not.toBe(revision);
          } else {
            expect(readSqliteDatabaseWriteRevision(database.db)).toBe(revision);
          }
          expect(database.db.prepare("SELECT task_id FROM task_runs").all()).toEqual(
            history === "retained" ? [{ task_id: "terminal" }] : [],
          );
        } finally {
          reads.restore();
          exec.mockRestore();
        }
      },
    );
  },
);

it("preserves complete receipt bodies and store partitions during selective recovery", async () => {
  await withOpenClawTestState(
    { layout: "state-only", prefix: "cron-history-payload-recovery-" },
    async (state) => {
      const database = openOpenClawStateDatabase();
      const nowMs = 10 * 24 * 60 * 60_000;
      const startedAt = nowMs - 10 * 60_000;
      const summary = "receipt evidence ".repeat(64_000);
      const recoveredDetail = { kind: "cron-run", storeKey: "right", receipt: { body: summary } };
      const lostDetail = { kind: "cron-run", storeKey: "lost", extra: ["preserve", { value: 7 }] };
      const insert = database.db.prepare(
        "INSERT INTO task_runs (task_id, runtime, source_id, run_id, owner_key, scope_kind, task, delivery_status, notify_policy, created_at, started_at, ended_at, status, terminal_summary, detail_json) VALUES (?, 'cron', ?, ?, '', 'system', 'history', 'not_applicable', 'silent', ?, ?, ?, ?, ?, ?)",
      );
      insert.run(
        "wrong-store",
        "job",
        "run",
        startedAt - 2,
        startedAt,
        startedAt + 1,
        "failed",
        "wrong",
        JSON.stringify({ kind: "cron-run", storeKey: "wrong" }),
      );
      const sourceJson = JSON.stringify(recoveredDetail, null, 2);
      insert.run(
        "source",
        "job",
        "run",
        startedAt - 1,
        startedAt,
        startedAt + 1,
        "succeeded",
        summary,
        sourceJson,
      );
      insert.run(
        "recover",
        "job",
        "run",
        startedAt,
        startedAt,
        null,
        "running",
        "old",
        JSON.stringify({ kind: "cron-run", storeKey: "right", old: true }),
      );
      insert.run(
        "lost",
        "other-job",
        "other-run",
        startedAt,
        startedAt,
        null,
        "running",
        "unfinished evidence",
        JSON.stringify(lostDetail),
      );
      insert.run(
        "protected",
        "protected-job",
        "protected-run",
        startedAt,
        startedAt,
        null,
        "running",
        summary,
        sourceJson,
      );
      const result = runWithSqliteWorkerStateContext(
        { environment: { OPENCLAW_STATE_DIR: state.stateDir } },
        () =>
          maintainCronRunHistoryInWorker(database, {
            snapshot: { nowMs, protectedJobIds: ["protected-job"] },
          }),
      );
      expect(result.outcome).toMatchObject({ reconciled: 2, pruned: 0 });
      const read = database.db.prepare(
        "SELECT status, terminal_summary, detail_json FROM task_runs WHERE task_id = ?",
      );
      expect(read.get("recover")).toEqual({
        status: "succeeded",
        terminal_summary: summary,
        detail_json: JSON.stringify(recoveredDetail),
      });
      expect(read.get("lost")).toEqual({
        status: "lost",
        terminal_summary: "unfinished evidence",
        detail_json: JSON.stringify(lostDetail),
      });
      expect(read.get("source")).toEqual({
        status: "succeeded",
        terminal_summary: summary,
        detail_json: sourceJson,
      });
      expect(read.get("protected")).toEqual({
        status: "running",
        terminal_summary: summary,
        detail_json: sourceJson,
      });
    },
  );
});
