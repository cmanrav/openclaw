import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { FollowThrough } from "./engine.mjs";
import { registerFollowThrough } from "./index.mjs";

// Exercise actual file-backed SQLite across owner restarts. Gateway effects here
// are a protocol test double, not a claim of installed Gateway/Telegram proof.
class SqliteStore {
  constructor(path) {
    this.database = new DatabaseSync(path);
    this.database.exec(
      "CREATE TABLE IF NOT EXISTS records (key TEXT PRIMARY KEY, revision INTEGER NOT NULL, value TEXT NOT NULL)",
    );
  }
  async entries() {
    return this.database
      .prepare("SELECT key,value FROM records")
      .all()
      .map((row) => ({ key: row.key, value: JSON.parse(row.value) }));
  }
  async lookup(key) {
    const row = this.database.prepare("SELECT value FROM records WHERE key=?").get(key);
    return row ? JSON.parse(row.value) : undefined;
  }
  async observe(key) {
    const row = this.database.prepare("SELECT revision,value FROM records WHERE key=?").get(key);
    return {
      comparison: String(row?.revision ?? -1),
      value: row ? JSON.parse(row.value) : undefined,
    };
  }
  async registerIfAbsent(key, value) {
    return (
      this.database
        .prepare("INSERT OR IGNORE INTO records VALUES (?,?,?)")
        .run(key, value.revision, JSON.stringify(value)).changes === 1
    );
  }
  async compareAndApply(key, comparison, intent) {
    const result = this.database
      .prepare("UPDATE records SET revision=?,value=? WHERE key=? AND revision=?")
      .run(intent.value.revision, JSON.stringify(intent.value), key, Number(comparison));
    return { status: result.changes ? "applied" : "conflict" };
  }
  close() {
    this.database.close();
  }
}
async function fixture(key = "agent:main:dashboard:qualification") {
  const directory = await mkdtemp(join(tmpdir(), "business-follow-through-"));
  let clock = 1000000;
  const calls = [],
    errors = [],
    results = new Map();
  const context = {
    sessionKey: key,
    sessionId: "original-session",
    agentId: key.split(":")[1],
    workspaceDir: directory,
    inputProvenance: { kind: "external_user" },
    assertInvocationCurrent() {},
  };
  const owner = { key, sessionId: context.sessionId, run: "idle", archived: false };
  const gateway = {
    available: true,
    failSend: false,
    failContinue: false,
    async isAvailable() {
      return this.available;
    },
    async readSessionFacts() {
      return { sessions: owner.missing ? [] : [owner] };
    },
    async request(method, parameters) {
      calls.push({ method, parameters });
      if (method === "send" && this.failSend) {
        throw new Error("Transport outcome unknown");
      }
      if (method === "sessions.send" && this.failContinue) {
        throw new Error("Rejected");
      }
      return method === "send"
        ? { messageId: "receipt-1" }
        : { runId: "admitted-run", status: "accepted" };
    },
  };
  const databasePath = join(directory, "tasks.sqlite");
  const nativeStateSdk = process.env.FOLLOW_THROUGH_NATIVE_STORE_SDK
    ? await import(process.env.FOLLOW_THROUGH_NATIVE_STORE_SDK)
    : undefined;
  const openStore = () =>
    nativeStateSdk
      ? {
          ...nativeStateSdk.createPluginStateKeyedStoreV2ForTests(
            "business-task-follow-through",
            {
              namespace: "qualification",
              maxEntries: 1000,
              overflowPolicy: "reject-new",
              env: { ...process.env, OPENCLAW_STATE_DIR: directory },
            },
            { assertCurrent() {} },
          ),
          close() {
            nativeStateSdk.resetPluginStateStoreForTests();
          },
        }
      : new SqliteStore(databasePath);
  let store = openStore();
  const nativeEntry = {};
  const create = () =>
    new FollowThrough({
      store,
      gateway,
      waitForRun: async ({ runId }) => results.get(runId) ?? { status: "pending" },
      readOwner: async () => nativeEntry,
      now: () => clock,
      reportFailure: (error) => errors.push(error.message),
      idleMs: 1000,
    });
  let engine = create();
  const task = await engine.prepare(
    { currentUserMessage: "Create a verified report", currentUserMessageId: "command-1" },
    context,
  );
  return {
    directory,
    context,
    task,
    gateway,
    owner,
    calls,
    errors,
    results,
    nativeEntry,
    get engine() {
      return engine;
    },
    get store() {
      return store;
    },
    advance() {
      clock += 1001;
    },
    restart() {
      store.close();
      store = openStore();
      engine = create();
    },
    async checkpoint(action, extra = {}) {
      return engine.checkpoint(context, {
        taskId: task.id,
        action,
        summary: "Controlled qualification task",
        ...extra,
      });
    },
  };
}
const dependencyOne = "11111111-1111-4111-8111-111111111111";
const dependencyTwo = "22222222-2222-4222-8222-222222222222";

test("success requires canonical evidence, independent review, and observed delivery before done", async () => {
  const fixtureState = await fixture();
  const path = join(fixtureState.directory, "completion-receipt.json");
  const receipt = {
    schema: "business-task-completion/1",
    taskId: fixtureState.task.id,
    canonicalLandingVerified: true,
    endToEndVerified: true,
    canonicalLocation: fixtureState.directory,
    canonicalRevision: "controlled-canonical-revision",
    expectedCount: 1,
    observedCount: 1,
    remainingActions: [],
  };
  const text = JSON.stringify(receipt);
  await writeFile(path, text);
  await assert.rejects(
    fixtureState.checkpoint("done", { evidencePath: path, sha256: "0".repeat(64) }),
    /digest/,
  );
  await fixtureState.checkpoint("done", {
    evidencePath: path,
    sha256: createHash("sha256").update(text).digest("hex"),
  });
  assert.equal((await fixtureState.store.lookup(fixtureState.task.id)).status, "review_pending");
  await assert.rejects(
    fixtureState.engine.review(fixtureState.context, {
      taskId: fixtureState.task.id,
      decision: "approve",
      summary: "Self review",
    }),
    /different live reviewer/,
  );
  await fixtureState.engine.review(
    {
      ...fixtureState.context,
      sessionKey: "agent:main:dashboard:independent-review",
      sessionId: "reviewer-session",
    },
    {
      taskId: fixtureState.task.id,
      decision: "approve",
      summary: "Independent canonical outcome verification",
    },
  );
  assert.equal((await fixtureState.store.lookup(fixtureState.task.id)).status, "delivery_pending");
  await fixtureState.engine.sweep();
  assert.equal((await fixtureState.store.lookup(fixtureState.task.id)).status, "done");
  fixtureState.restart();
  await fixtureState.engine.sweep();
  assert.equal(fixtureState.calls.filter((call) => call.method === "send").length, 1);
});

test("dependency failure creates exactly one alert across restart", async () => {
  const fixtureState = await fixture();
  await fixtureState.checkpoint("wait_dependency", { runIds: [dependencyOne] });
  fixtureState.results.set(dependencyOne, {
    status: "error",
    endedAt: 999,
    error: "controlled failure",
  });
  await fixtureState.engine.sweep();
  fixtureState.restart();
  await fixtureState.engine.sweep();
  assert.equal((await fixtureState.store.lookup(fixtureState.task.id)).status, "failed");
  assert.equal(fixtureState.calls.length, 1);
});
test("dependency completion automatically admits the same dashboard owner only once", async () => {
  const fixtureState = await fixture();
  await fixtureState.checkpoint("wait_dependency", { runIds: [dependencyOne] });
  fixtureState.results.set(dependencyOne, { status: "ok", endedAt: 999 });
  await fixtureState.engine.sweep();
  fixtureState.restart();
  await fixtureState.engine.sweep();
  assert.equal(fixtureState.calls.length, 1);
  assert.equal(fixtureState.calls[0].method, "sessions.send");
  assert.equal(fixtureState.calls[0].parameters.key, fixtureState.context.sessionKey);
  assert.equal(
    (await fixtureState.store.lookup(fixtureState.task.id)).status,
    "waiting_dependency",
  );
});
test("reproduced completed-prerequisite/message-paused-sibling cycle wakes original owner", async () => {
  const fixtureState = await fixture();
  await fixtureState.checkpoint("wait_dependency", { runIds: [dependencyOne, dependencyTwo] });
  fixtureState.results.set(dependencyOne, { status: "ok", endedAt: 999 });
  fixtureState.results.set(dependencyTwo, { status: "ok", endedAt: 999, yielded: true });
  await fixtureState.engine.sweep();
  assert.match(fixtureState.calls[0].parameters.message, /message-paused sibling/);
  assert.equal(fixtureState.calls[0].parameters.key, fixtureState.context.sessionKey);
});
test("owner disappearance blocks and alerts without resuming or replaying writes", async () => {
  const fixtureState = await fixture();
  fixtureState.owner.missing = true;
  await fixtureState.engine.sweep();
  assert.equal((await fixtureState.store.lookup(fixtureState.task.id)).status, "blocked");
  assert.deepEqual(
    fixtureState.calls.map((call) => call.method),
    ["send"],
  );
});
test("turn ended incomplete and model failure are distinct terminal incidents", async () => {
  for (const success of [true, false]) {
    const fixtureState = await fixture();
    await fixtureState.engine.end(fixtureState.context, { success });
    await fixtureState.engine.sweep();
    assert.equal(
      (await fixtureState.store.lookup(fixtureState.task.id)).status,
      success ? "stalled" : "failed",
    );
    assert.equal(fixtureState.calls.length, 1);
  }
});
test("cancellation suppresses late dependency results, duplicate admission and restart resurrection", async () => {
  const fixtureState = await fixture();
  await fixtureState.checkpoint("wait_dependency", { runIds: [dependencyOne] });
  await fixtureState.engine.prepare(
    { currentUserMessage: "cancel", currentUserMessageId: "cancel-2" },
    fixtureState.context,
  );
  fixtureState.results.set(dependencyOne, { status: "ok" });
  fixtureState.restart();
  await fixtureState.engine.sweep();
  const repeated = await fixtureState.engine.prepare(
    { currentUserMessage: "Create a verified report", currentUserMessageId: "command-1" },
    fixtureState.context,
  );
  assert.equal(repeated, undefined);
  assert.equal(fixtureState.calls.length, 0);
  await assert.rejects(fixtureState.checkpoint("progress"), /Terminal/);
});
test("human approval waits are retained, not resumed or nagged", async () => {
  const fixtureState = await fixture();
  await fixtureState.checkpoint("wait_approval");
  fixtureState.advance();
  fixtureState.restart();
  await fixtureState.engine.sweep();
  assert.equal(fixtureState.calls.length, 0);
  assert.equal((await fixtureState.store.lookup(fixtureState.task.id)).status, "waiting_approval");
});
test("idle owner alerts; a busy owner is not interrupted; identity replacement never resumes", async () => {
  for (const state of ["idle", "active", "replaced"]) {
    const fixtureState = await fixture();
    if (state === "replaced") {
      fixtureState.owner.sessionId = "replacement-session";
    } else {
      fixtureState.owner.run = state;
    }
    fixtureState.advance();
    await fixtureState.engine.sweep();
    assert.equal(
      (await fixtureState.store.lookup(fixtureState.task.id)).status,
      state === "replaced" ? "blocked" : "stalled",
    );
    assert.deepEqual(
      fixtureState.calls.map((call) => call.method),
      ["send"],
    );
  }
});
test("notification uncertain outcome is retained and never blindly resent after restart", async () => {
  const fixtureState = await fixture();
  fixtureState.gateway.failSend = true;
  await fixtureState.checkpoint("failed");
  await fixtureState.engine.sweep();
  fixtureState.restart();
  await fixtureState.engine.sweep();
  await fixtureState.engine.sweep();
  assert.equal(fixtureState.calls.length, 1);
  assert.equal(
    (await fixtureState.store.lookup(fixtureState.task.id)).notification.state,
    "reported",
  );
  assert.ok(fixtureState.errors.length > 0);
});
test("pre-admission notification unavailability is bounded to three checks", async () => {
  const fixtureState = await fixture();
  fixtureState.gateway.available = false;
  await fixtureState.checkpoint("failed");
  for (let iteration = 0; iteration < 6; iteration++) {
    await fixtureState.engine.sweep();
  }
  assert.equal(fixtureState.calls.length, 0);
  assert.equal((await fixtureState.store.lookup(fixtureState.task.id)).notification.attempts, 3);
});
test("person chat never receives an injected continuation", async () => {
  const fixtureState = await fixture("agent:main:telegram:direct:8600742312");
  await fixtureState.checkpoint("wait_dependency", { runIds: [dependencyOne] });
  fixtureState.results.set(dependencyOne, { status: "ok" });
  await fixtureState.engine.sweep();
  assert.deepEqual(
    fixtureState.calls.map((call) => call.method),
    ["send"],
  );
  assert.equal((await fixtureState.store.lookup(fixtureState.task.id)).status, "blocked");
});
test("JCR and other agents cannot enroll or use the tool, and internal inputs do not create work", async () => {
  const fixtureState = await fixture();
  for (const sessionKey of ["agent:jcr:main", "agent:other:dashboard:foo"]) {
    assert.equal(
      await fixtureState.engine.prepare(
        { currentUserMessage: "Do work", currentUserMessageId: "new" },
        { ...fixtureState.context, sessionKey },
      ),
      undefined,
    );
    await assert.rejects(
      fixtureState.engine.checkpoint(
        { ...fixtureState.context, sessionKey },
        { taskId: fixtureState.task.id, action: "failed" },
      ),
      /lane/,
    );
  }
  assert.equal(
    await fixtureState.engine.prepare(
      {},
      {
        ...fixtureState.context,
        sessionKey: "agent:main:dashboard:other",
        inputProvenance: { kind: "inter_session" },
      },
    ),
    undefined,
  );
});
test("registered hook and tool wiring uses host scheduler and one bounded revision", async () => {
  const fixtureState = await fixture();
  const hooks = new Map();
  let toolFactory, service;
  const engine = registerFollowThrough({
    pluginConfig: { notificationTarget: "qualification-operator" },
    runtime: {
      state: { openKeyedStoreV2: () => fixtureState.store },
      gateway: fixtureState.gateway,
      agent: { session: { getSessionEntryAsync: async () => ({}) } },
      subagent: { waitForRun: async () => ({ status: "pending" }) },
    },
    logger: { error() {} },
    on: (name, handler) => hooks.set(name, handler),
    registerTool: (factory) => {
      if (!toolFactory) {
        toolFactory = factory;
      }
    },
    registerGatewayMethod() {},
    registerService: (registration) => {
      service = registration;
    },
  });
  assert.ok(engine);
  assert.equal(toolFactory.create({ sessionKey: "agent:jcr:main" }), null);
  const revision = await hooks.get("before_agent_finalize")({}, fixtureState.context);
  assert.equal(revision.retry.maxAttempts, 1);
  let job;
  service.start({
    scheduler: {
      schedule: (registration) => {
        job = registration;
      },
    },
    serviceHealth: { reportFailure() {} },
  });
  assert.equal(job.everyMs, 60000);
  await service.stop();
});

test("native stop cutoff suppresses canceled owner failure and late dependency wake", async () => {
  const fixtureState = await fixture();
  await fixtureState.checkpoint("wait_dependency", { runIds: [dependencyOne] });
  fixtureState.nativeEntry.abortCutoffTimestamp = 1000001;
  fixtureState.results.set(dependencyOne, { status: "ok" });
  await fixtureState.engine.end(fixtureState.context, { success: false });
  fixtureState.restart();
  await fixtureState.engine.sweep();
  assert.equal((await fixtureState.store.lookup(fixtureState.task.id)).status, "canceled");
  assert.equal(fixtureState.calls.length, 0);
});
test("active dependency is not mistaken for an abandoned owner", async () => {
  const fixtureState = await fixture();
  await fixtureState.checkpoint("wait_dependency", { runIds: [dependencyOne] });
  fixtureState.advance();
  await fixtureState.engine.sweep();
  assert.equal(
    (await fixtureState.store.lookup(fixtureState.task.id)).status,
    "waiting_dependency",
  );
  assert.equal(fixtureState.calls.length, 0);
});
test("rejected continuation stalls once without creating a new owner", async () => {
  const fixtureState = await fixture();
  fixtureState.gateway.failContinue = true;
  await fixtureState.checkpoint("wait_dependency", { runIds: [dependencyOne] });
  fixtureState.results.set(dependencyOne, { status: "ok" });
  await fixtureState.engine.sweep();
  fixtureState.restart();
  await fixtureState.engine.sweep();
  assert.equal((await fixtureState.store.lookup(fixtureState.task.id)).status, "stalled");
  assert.deepEqual(
    fixtureState.calls.map((call) => call.method),
    ["sessions.send", "send"],
  );
});

test("admitted continuation is not completion and an idle successor remains recoverable", async () => {
  const fixtureState = await fixture();
  await fixtureState.checkpoint("wait_dependency", { runIds: [dependencyOne] });
  fixtureState.results.set(dependencyOne, { status: "ok" });
  await fixtureState.engine.sweep();
  fixtureState.advance();
  await fixtureState.engine.sweep();
  assert.equal((await fixtureState.store.lookup(fixtureState.task.id)).status, "stalled");
  assert.deepEqual(
    fixtureState.calls.map((call) => call.method),
    ["sessions.send", "send"],
  );
});
test("interrupted notification claim survives restart without a duplicate external send", async () => {
  const fixtureState = await fixture();
  await fixtureState.checkpoint("failed");
  const task = await fixtureState.store.lookup(fixtureState.task.id);
  task.notification.state = "sending";
  await fixtureState.engine.save(task);
  fixtureState.restart();
  await fixtureState.engine.sweep();
  assert.equal(fixtureState.calls.length, 0);
  assert.equal(
    (await fixtureState.store.lookup(fixtureState.task.id)).notification.state,
    "reported",
  );
});
test("a running command cannot be dismissed by a casual status question", async () => {
  const fixtureState = await fixture();
  await fixtureState.checkpoint("progress");
  await assert.rejects(fixtureState.checkpoint("conversation"), /cannot dismiss/);
});

test("host-proven delegated Tax Analyst task enrolls; a completion message does not", async () => {
  const fixtureState = await fixture();
  const context = {
    ...fixtureState.context,
    agentId: "rendio-taxanalyst",
    sessionKey: "agent:rendio-taxanalyst:subagent:delegated",
    inputProvenance: { kind: "inter_session", sourceTool: "sessions_spawn" },
  };
  const task = await fixtureState.engine.prepare(
    {
      currentUserMessage: "Finish the authorized report",
      currentUserMessageId: "native-assignment",
    },
    context,
  );
  assert.equal(task.status, "running");
  assert.equal(
    await fixtureState.engine.prepare(
      { currentUserMessage: "Completed", currentUserMessageId: "completion" },
      {
        ...context,
        sessionKey: "agent:rendio-taxanalyst:dashboard:completion-only",
        inputProvenance: { kind: "inter_session", sourceTool: "agent_harness_completion" },
      },
    ),
    undefined,
  );
});
test("stalled active ownership accepts a later legitimate checkpoint without resurrection", async () => {
  const fixtureState = await fixture();
  await fixtureState.checkpoint("progress");
  fixtureState.owner.run = "active";
  fixtureState.advance();
  await fixtureState.engine.sweep();
  assert.equal((await fixtureState.store.lookup(fixtureState.task.id)).status, "stalled");
  await fixtureState.checkpoint("progress");
  assert.equal((await fixtureState.store.lookup(fixtureState.task.id)).status, "running");
  assert.equal(fixtureState.calls.length, 1);
});
test("new explicit approval can progress the same waiting task without losing its goal", async () => {
  const fixtureState = await fixture();
  const goal = fixtureState.task.goal;
  await fixtureState.checkpoint("wait_approval");
  const prepared = await fixtureState.engine.prepare(
    { currentUserMessage: "Approved for that exact action", currentUserMessageId: "approval-2" },
    fixtureState.context,
  );
  assert.equal(prepared.id, fixtureState.task.id);
  assert.equal(prepared.status, "waiting_approval");
  await fixtureState.checkpoint("progress");
  assert.equal((await fixtureState.store.lookup(fixtureState.task.id)).goal, goal);
});
test("arbitrary hashed file or plan receipt cannot become done", async () => {
  const fixtureState = await fixture();
  const path = join(fixtureState.directory, "plan.json");
  const text = JSON.stringify({ status: "plan complete" });
  await writeFile(path, text);
  await assert.rejects(
    fixtureState.checkpoint("done", {
      evidencePath: path,
      sha256: createHash("sha256").update(text).digest("hex"),
    }),
    /not completed work/,
  );
  assert.equal((await fixtureState.store.lookup(fixtureState.task.id)).status, "running");
});
test("explicit original-owner adoption checks identity and cancellation, never scans historic tasks", async () => {
  const fixtureState = await fixture();
  const parameters = {
    sessionKey: fixtureState.context.sessionKey,
    expectedSessionId: fixtureState.context.sessionId,
    originalMessageId: "original-command",
    originalStartedAt: 999000,
    goal: "Original authorized goal",
    runIds: [dependencyOne],
  };
  fixtureState.nativeEntry.abortCutoffTimestamp = 999500;
  await assert.rejects(fixtureState.engine.adopt(parameters), /cancellation/);
  delete fixtureState.nativeEntry.abortCutoffTimestamp;
  await assert.rejects(
    fixtureState.engine.adopt({ ...parameters, expectedSessionId: "stale-owner" }),
    /identity/,
  );
});

test("exact operator adoption retains one original Tax Analyst owner and dependency set", async () => {
  const state = await fixture("agent:rendio-taxanalyst:dashboard:original-owner");
  await state.checkpoint("canceled");
  const parameters = {
    sessionKey: state.context.sessionKey,
    expectedSessionId: state.context.sessionId,
    originalMessageId: "narrowly-authorized-existing-task",
    originalStartedAt: 999000,
    goal: "Existing authorized business command",
    runIds: [dependencyOne, dependencyOne],
  };
  const task = await state.engine.adopt(parameters);
  assert.equal(task.status, "waiting_dependency");
  assert.deepEqual(task.dependencies, [dependencyOne]);
  assert.equal(task.sessionId, state.context.sessionId);
  assert.equal((await state.engine.adopt(parameters)).id, task.id);
  assert.equal(state.calls.length, 0);
});

test("native untyped assignment enrolls only with matching current business spawn lineage", async () => {
  const state = await fixture("agent:rendio-taxanalyst:subagent:native-assignment");
  await state.checkpoint("canceled");
  const context = { ...state.context, inputProvenance: undefined };
  const event = {
    currentUserMessage: "Native task assignment",
    currentUserMessageId: "native-initial",
  };
  assert.equal(await state.engine.prepare(event, context), undefined);
  state.nativeEntry.sessionId = state.context.sessionId;
  state.nativeEntry.spawnedBy = "agent:jcr:dashboard:excluded";
  assert.equal(await state.engine.prepare(event, context), undefined);
  state.nativeEntry.spawnedBy = "agent:main:dashboard:business-owner";
  state.nativeEntry.abortedLastRun = true;
  assert.equal(await state.engine.prepare(event, context), undefined);
  state.nativeEntry.abortedLastRun = false;
  assert.equal((await state.engine.prepare(event, context)).status, "running");
});
