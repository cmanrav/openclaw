import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import * as tar from "tar";
import { describe, expect, it, vi } from "vitest";
import { backupRestoreCommand } from "../commands/backup-restore.js";
import { verifyBackupArchive } from "../commands/backup-verify.js";
import { CONFIG_AUDIT_MAX_ENTRIES, CONFIG_AUDIT_SCOPE } from "../config/io.audit.js";
import { EMPTY_LEGACY_SESSION_SURFACES } from "../plugins/legacy-session-surfaces.types.js";
import type { RuntimeEnv } from "../runtime.js";
import { closeOpenClawStateDatabaseByPath } from "../state/openclaw-state-db-cache.js";
import {
  closeOpenClawStateDatabase,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import * as stateDatabase from "../state/openclaw-state-db.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { createBackupArchive } from "./backup-create.js";
import { listArchiveEntries, listArchiveEntryDetails } from "./backup-create.test-support.js";
import * as backupSqliteSnapshot from "./backup-sqlite-snapshot.js";
import { requireNodeSqlite } from "./node-sqlite.js";
import { createSqliteAuditRecordStore } from "./sqlite-audit-record-store.js";
import { detectLegacyAuditLogs, migrateLegacyAuditLogs } from "./state-migrations.audit-logs.js";
import { autoMigrateLegacyState } from "./state-migrations.doctor.js";
import { throwIfDoctorStateMigrationRefused } from "./state-migrations.messages.js";

function auditRecord(key: string, value: string) {
  return {
    ts: "2026-07-01T00:00:00.000Z",
    source: "config-io",
    event: "config.write",
    argv: ["openclaw", "config", "set", key, value],
    execArgv: [],
  };
}

function withAuditState(run: (state: OpenClawTestState) => Promise<void>) {
  return withOpenClawTestState({ layout: "state-only", scenario: "minimal" }, run);
}

async function captureBackup(state: OpenClawTestState, minute: number) {
  const output = state.path("backups");
  const extractDir = state.path("extract");
  await fs.mkdir(output);
  await fs.mkdir(extractDir);
  const result = await createBackupArchive({
    output,
    includeWorkspace: false,
    nowMs: Date.UTC(2026, 4, 9, 8, minute, 0),
  });
  const entries = await listArchiveEntries(result.archivePath);
  const databaseEntry = expectDefined(
    entries.find((entry) => entry.endsWith("/state/state/openclaw.sqlite")),
    "global state database entry",
  );
  await tar.x({ file: result.archivePath, gzip: true, cwd: extractDir });
  return { result, entries, extractDir, databasePath: path.join(extractDir, databaseEntry) };
}

function expectNoArchivedCheckpoints(databasePath: string) {
  const database = new (requireNodeSqlite().DatabaseSync)(databasePath, { readOnly: true });
  try {
    expect(
      database
        .prepare(
          "SELECT COUNT(*) AS count FROM diagnostic_events WHERE scope = 'migration.legacy-audit-raw'",
        )
        .get(),
    ).toEqual({ count: 0 });
  } finally {
    database.close();
  }
}

describe("legacy audit portable backups", () => {
  it("replaces legacy audit raw archives with sanitized restorable snapshots", async () => {
    await withAuditState(async (state) => {
      const rawRelativePath = "logs/config-audit.jsonl.migrated.raw";
      const marker = "audit-value-7f3c";
      await state.writeText(rawRelativePath, `${JSON.stringify(auditRecord("token", marker))}\n`);
      const { db } = openOpenClawStateDatabase({ env: state.env });
      db.prepare(
        `
            INSERT INTO diagnostic_events (
              scope, event_key, payload_json, created_at, sequence
            ) VALUES ('migration.legacy-audit-raw', 'checkpoint', '{}', 1, 1)
          `,
      ).run();

      try {
        const { entries, extractDir, databasePath } = await captureBackup(state, 15);
        const rawEntry = expectDefined(
          entries.find((entry) => entry.endsWith(`/state/${rawRelativePath}`)),
          "sanitized raw archive entry",
        );
        expect(entries.some((entry) => entry.endsWith(".doctor-scrub-restore"))).toBe(false);
        const archivedRaw = await fs.readFile(path.join(extractDir, rawEntry), "utf8");
        expect(archivedRaw).not.toContain(marker);
        expect(JSON.parse(archivedRaw.trim())).toMatchObject({
          argv: ["openclaw", "config", "set", "token", "***"],
        });
        expectNoArchivedCheckpoints(databasePath);
      } finally {
        closeOpenClawStateDatabase();
      }
    });
  });

  it.each(["completed", "quarantined"])(
    "omits %s audit append pads from portable backups",
    async (shape) => {
      await withAuditState(async (state) => {
        const sourcePath = state.statePath("logs/config-audit.jsonl");
        const rawRelativePath = "logs/config-audit.jsonl.migrated.raw";
        const marker = "quarantined-audit-value-7f3c";
        await fs.mkdir(path.dirname(sourcePath), { recursive: true });
        await fs.writeFile(sourcePath, `${JSON.stringify(auditRecord("safe", "value"))}\n`);
        await migrateLegacyAuditLogs({
          detected: detectLegacyAuditLogs({
            stateDir: state.stateDir,
            doctorOnlyStateMigrations: true,
          }),
          stateDir: state.stateDir,
        });
        expect(
          detectLegacyAuditLogs({
            stateDir: state.stateDir,
            doctorOnlyStateMigrations: true,
          }).hasLegacy,
        ).toBe(false);
        const sanitizedPath = `${sourcePath}.migrated`;
        const sanitizedBytes = await fs.readFile(sanitizedPath);
        let retainedPath = state.statePath(rawRelativePath);
        if (shape === "quarantined") {
          await fs.writeFile(retainedPath, `${JSON.stringify(auditRecord("token", marker))}\n`);
          const cfg = { plugins: { enabled: false } };
          await state.writeConfig(cfg);
          const doctor = await autoMigrateLegacyState({
            cfg,
            env: state.env,
            homedir: () => state.home,
            doctorOnlyStateMigrations: true,
            legacySessionSurfaces: EMPTY_LEGACY_SESSION_SURFACES,
          });
          expect(() => throwIfDoctorStateMigrationRefused(doctor.stepReceipts)).not.toThrow();
          const quarantines = (await fs.readdir(path.dirname(retainedPath))).filter((name) =>
            name.startsWith("config-audit.jsonl.migrated.raw.quarantined-"),
          );
          expect(quarantines, doctor.warnings.join("\n")).toHaveLength(1);
          retainedPath = path.join(path.dirname(retainedPath), quarantines[0]!);
          expect(doctor.warnings).toContainEqual(expect.stringContaining(retainedPath));
        }
        const retainedBytes = await fs.readFile(retainedPath);
        if (shape === "quarantined") {
          expect(retainedBytes.toString()).toContain(marker);
        }
        const { db } = openOpenClawStateDatabase({ env: state.env });
        expect(
          db
            .prepare(
              "SELECT COUNT(*) AS count FROM diagnostic_events WHERE scope = 'migration.legacy-audit-raw'",
            )
            .get(),
        ).toEqual({ count: 1 });

        try {
          const { result, entries, extractDir, databasePath } = await captureBackup(state, 20);
          expect(entries.some((entry) => entry.endsWith(`/state/${rawRelativePath}`))).toBe(false);
          expect(entries.some((entry) => entry.includes(".quarantined-"))).toBe(false);
          const sanitizedEntry = expectDefined(
            entries.find((entry) => entry.endsWith("/state/logs/config-audit.jsonl.migrated")),
            "sanitized audit history",
          );
          await expect(fs.readFile(path.join(extractDir, sanitizedEntry))).resolves.toEqual(
            sanitizedBytes,
          );
          for (const entry of await listArchiveEntryDetails(result.archivePath)) {
            if (entry.type === "File") {
              const contents = await fs.readFile(path.join(extractDir, entry.path));
              expect(contents.includes(Buffer.from(marker)), entry.path).toBe(false);
            }
          }
          await expect(fs.readFile(retainedPath)).resolves.toEqual(retainedBytes);
          await expect(fs.readFile(sanitizedPath)).resolves.toEqual(sanitizedBytes);
          expectNoArchivedCheckpoints(databasePath);
        } finally {
          closeOpenClawStateDatabase();
        }
      });
    },
  );

  it("preserves audit ordinals for identical later appends across backup restore", async () => {
    await withAuditState(async (state) => {
      const sourcePath = state.statePath("logs/config-audit.jsonl");
      const rawRelativePath = "logs/config-audit.jsonl.migrated.raw";
      const record = auditRecord("safe", "same");
      await fs.mkdir(path.dirname(sourcePath), { recursive: true });
      await fs.writeFile(sourcePath, `${JSON.stringify(record)}\n`);
      await migrateLegacyAuditLogs({
        detected: detectLegacyAuditLogs({
          stateDir: state.stateDir,
          doctorOnlyStateMigrations: true,
        }),
        stateDir: state.stateDir,
      });
      await fs.appendFile(state.statePath(rawRelativePath), `${JSON.stringify(record)}\n`);

      const { databasePath: restoredDatabasePath } = await captureBackup(state, 25);
      closeOpenClawStateDatabase();

      const restoredStateDir = path.dirname(path.dirname(restoredDatabasePath));
      try {
        const restoredDetection = detectLegacyAuditLogs({
          stateDir: restoredStateDir,
          doctorOnlyStateMigrations: true,
        });
        expect(restoredDetection.hasLegacy).toBe(true);
        await migrateLegacyAuditLogs({
          detected: restoredDetection,
          stateDir: restoredStateDir,
        });
        const restoredEntries = createSqliteAuditRecordStore({
          scope: CONFIG_AUDIT_SCOPE,
          maxEntries: CONFIG_AUDIT_MAX_ENTRIES,
          env: { ...process.env, OPENCLAW_STATE_DIR: restoredStateDir },
        }).entries();
        expect(new Set(restoredEntries.map((entry) => entry.key)).size).toBe(2);
        expect(restoredEntries.map((entry) => entry.value)).toEqual([record, record]);
      } finally {
        closeOpenClawStateDatabaseByPath(restoredDatabasePath);
      }
    });
  });
});

describe("backup legacy audit capture boundary", () => {
  it("backs up an older owned store and raw audit without opening a writer or migrating it", async () => {
    await withAuditState(async (state) => {
      await state.writeConfig({ plugins: { enabled: false } });
      const databasePath = state.statePath("state", "openclaw.sqlite");
      await fs.mkdir(path.dirname(databasePath), { recursive: true });
      closeOpenClawStateDatabase();
      const database = new (requireNodeSqlite().DatabaseSync)(databasePath);
      // Original schema17 table shapes, not a current store with a decremented marker.
      database.exec(`
        CREATE TABLE schema_meta (
          meta_key TEXT PRIMARY KEY, role TEXT NOT NULL, schema_version INTEGER NOT NULL,
          agent_id TEXT, app_version TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
        ) STRICT;
        INSERT INTO schema_meta VALUES ('primary', 'global', 17, NULL, '2026.9.4', 1, 1);
        PRAGMA user_version = 17;
        CREATE TABLE diagnostic_events (
          scope TEXT NOT NULL, event_key TEXT NOT NULL, payload_json TEXT NOT NULL,
          created_at INTEGER NOT NULL, sequence INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (scope, event_key)
        ) STRICT;
        CREATE TABLE agent_databases (
          agent_id TEXT NOT NULL, path TEXT NOT NULL, schema_version INTEGER NOT NULL,
          last_seen_at INTEGER NOT NULL, size_bytes INTEGER, PRIMARY KEY (agent_id, path)
        ) STRICT;
        CREATE TABLE state_leases (
          scope TEXT NOT NULL, lease_key TEXT NOT NULL, owner TEXT NOT NULL,
          expires_at INTEGER, heartbeat_at INTEGER, payload_json TEXT,
          created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
          PRIMARY KEY (scope, lease_key)
        ) STRICT;
      `);
      database.close();
      const rawPath = "logs/config-audit.jsonl.migrated.raw";
      await state.writeText(rawPath, `${JSON.stringify(auditRecord("safe", "older-store"))}\n`);
      const linkPath = state.statePath("absolute-workspace-link");
      await fs.symlink(state.workspaceDir, linkPath);
      const originalBytes = await fs.readFile(databasePath);
      const originalHash = createHash("sha256").update(originalBytes).digest("hex");
      // Isolation: emulate the live owner's refusal of every writable open/transaction.
      const writer = vi.spyOn(stateDatabase, "openOpenClawStateDatabase").mockImplementation(() => {
        throw new Error("Backup attempted a writable open of the older source");
      });
      // Isolation: the older live owner also rejects transaction entry, independently of opens.
      const transaction = vi
        .spyOn(stateDatabase, "runOpenClawStateWriteTransaction")
        .mockImplementation(() => {
          throw new Error("Backup attempted a writable transaction on the older source");
        });
      try {
        const result = await createBackupArchive({
          output: state.path("older-store.tar.gz"),
          includeWorkspace: false,
          verify: true,
        });
        const verification = await verifyBackupArchive(result.archivePath);
        expect(verification.ok).toBe(true);
        expect(writer).not.toHaveBeenCalled();
        expect(transaction).not.toHaveBeenCalled();
        const runtime: RuntimeEnv = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
        const restored = await backupRestoreCommand(runtime, {
          archive: result.archivePath,
          target: state.path("restored-older-store"),
        });
        // SAFETY: native verification and restore have validated this archive's asset schema.
        const manifest = JSON.parse(
          await fs.readFile(
            path.join(restored.targetPath, result.archiveRoot, "manifest.json"),
            "utf8",
          ),
        ) as { assets: Array<{ kind: string; archivePath: string }> };
        const asset = expectDefined(
          manifest.assets.find((row) => row.kind === "state"),
          "state asset",
        );
        const restoredState = path.join(restored.targetPath, asset.archivePath);
        const restoredDatabase = new (requireNodeSqlite().DatabaseSync)(
          path.join(restoredState, "state", "openclaw.sqlite"),
          { readOnly: true },
        );
        try {
          expect(restoredDatabase.prepare("PRAGMA user_version").get()).toEqual({
            user_version: 17,
          });
        } finally {
          restoredDatabase.close();
        }
        await expect(
          fs.readlink(path.join(restoredState, "absolute-workspace-link")),
        ).resolves.toBe(state.workspaceDir);
        await expect(fs.readlink(linkPath)).resolves.toBe(state.workspaceDir);
        expect(
          createHash("sha256")
            .update(await fs.readFile(databasePath))
            .digest("hex"),
        ).toBe(originalHash);
        await expect(fs.readFile(state.statePath(rawPath))).resolves.toEqual(
          Buffer.from(`${JSON.stringify(auditRecord("safe", "older-store"))}\n`),
        );
      } finally {
        writer.mockRestore();
        transaction.mockRestore();
      }
    });
  });
  it.each(["lease-duration overrun", "concurrent audit migration"] as const)(
    "restores audit records exactly once after %s during the SQLite snapshot",
    async (scenario) => {
      await withOpenClawTestState(
        { layout: "state-only", prefix: "backup-audit-boundary-", scenario: "minimal" },
        async (state) => {
          const record = {
            ts: "2026-07-01T00:00:00.000Z",
            source: "config-io",
            event: "config.write",
            argv: ["openclaw", "config", "set", "safe", "preserved-audit-record"],
            execArgv: [],
          };
          await state.writeText("logs/config-audit.jsonl", `${JSON.stringify(record)}\n`);
          const originalSnapshot = backupSqliteSnapshot.createBackupSqliteSnapshotPlan;
          const realNow = Date.now.bind(Date);
          const clock = vi.spyOn(Date, "now");
          let snapshotReached = false;
          const snapshot = vi
            .spyOn(backupSqliteSnapshot, "createBackupSqliteSnapshotPlan")
            .mockImplementationOnce(async (params) => {
              snapshotReached = true;
              if (scenario === "lease-duration overrun") {
                clock.mockImplementation(() => realNow() + 61_000);
              } else {
                const migrated = await migrateLegacyAuditLogs({
                  detected: detectLegacyAuditLogs({
                    stateDir: state.stateDir,
                    doctorOnlyStateMigrations: true,
                  }),
                  stateDir: state.stateDir,
                });
                expect(migrated.warnings).toEqual([]);
              }
              try {
                return await originalSnapshot(params);
              } finally {
                clock.mockRestore();
              }
            });
          try {
            const archive = await createBackupArchive({
              output: state.path("backup.tar.gz"),
              includeWorkspace: false,
            });
            expect(snapshotReached).toBe(true);
            clock.mockRestore();
            snapshot.mockRestore();
            const runtime: RuntimeEnv = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
            const restored = await backupRestoreCommand(runtime, {
              archive: archive.archivePath,
              target: state.path("restored"),
            });
            const manifest = JSON.parse(
              await fs.readFile(
                path.join(restored.targetPath, archive.archiveRoot, "manifest.json"),
                "utf8",
              ),
            ) as { assets: Array<{ kind: string; archivePath: string }> };
            const stateAsset = expectDefined(
              manifest.assets.find((asset) => asset.kind === "state"),
              "restored state asset",
            );
            const restoredStateDir = path.join(restored.targetPath, stateAsset.archivePath);
            for (let attempt = 0; attempt < 2; attempt += 1) {
              const migrated = await migrateLegacyAuditLogs({
                detected: detectLegacyAuditLogs({
                  stateDir: restoredStateDir,
                  doctorOnlyStateMigrations: true,
                }),
                stateDir: restoredStateDir,
              });
              expect(migrated.warnings).toEqual([]);
            }
            const records = createSqliteAuditRecordStore({
              scope: CONFIG_AUDIT_SCOPE,
              maxEntries: CONFIG_AUDIT_MAX_ENTRIES,
              env: { ...state.env, OPENCLAW_STATE_DIR: restoredStateDir },
            }).entries();
            expect(records.map((entry) => entry.value)).toEqual([record]);
          } finally {
            clock.mockRestore();
            snapshot.mockRestore();
            closeOpenClawStateDatabase();
          }
        },
      );
    },
  );

  it("fails closed after bounded retries when the legacy source keeps changing", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "backup-audit-retry-", scenario: "minimal" },
      async (state) => {
        const sourcePath = path.join(state.stateDir, "logs/config-audit.jsonl");
        const outputPath = state.path("backup.tar.gz");
        await state.writeText(
          "logs/config-audit.jsonl",
          `${JSON.stringify({
            ts: "2026-07-01T00:00:00.000Z",
            source: "config-io",
            event: "config.write",
            argv: ["openclaw", "config", "set", "safe", "initial"],
            execArgv: [],
          })}\n`,
        );
        const originalSnapshot = backupSqliteSnapshot.createBackupSqliteSnapshotPlan;
        let snapshotAttempts = 0;
        const snapshot = vi
          .spyOn(backupSqliteSnapshot, "createBackupSqliteSnapshotPlan")
          .mockImplementation(async (params) => {
            snapshotAttempts += 1;
            await fs.appendFile(
              sourcePath,
              `${JSON.stringify({
                ts: `2026-07-01T00:00:0${snapshotAttempts}.000Z`,
                source: "config-io",
                event: "config.write",
                argv: ["openclaw", "config", "set", "safe", `append-${snapshotAttempts}`],
                execArgv: [],
              })}\n`,
            );
            return await originalSnapshot(params);
          });
        try {
          await expect(
            createBackupArchive({ output: outputPath, includeWorkspace: false }),
          ).rejects.toThrow(/retry backup after legacy audit migration settles/iu);
          expect(snapshotAttempts).toBe(3);
          await expect(fs.access(outputPath)).rejects.toMatchObject({ code: "ENOENT" });
        } finally {
          snapshot.mockRestore();
          closeOpenClawStateDatabase();
        }
      },
    );
  });
});
