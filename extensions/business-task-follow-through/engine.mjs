import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { relative, isAbsolute } from "node:path";

export const terminalStates = new Set(["done", "blocked", "failed", "canceled", "conversation"]);
export const businessSession = (key) => /^agent:(main|rendio-taxanalyst):/.test(key ?? "");
export const resumableSession = (key) =>
  /^agent:(main|rendio-taxanalyst):(dashboard|subagent):/.test(key ?? "");
const digest = (text) => createHash("sha256").update(text).digest("hex");
const bounded = (text) => String(text ?? "").slice(0, 600);

// All mutations and side effects share one queue. The host joins service/tool work
// before replacement; durable compare-and-apply also refuses competing generations.
export class FollowThrough {
  constructor({
    store,
    gateway,
    waitForRun,
    now = Date.now,
    reportFailure,
    notificationTarget = "qualification-operator",
    readOwner = async () => ({}),
    idleMs = 900000,
  }) {
    Object.assign(this, {
      store,
      gateway,
      waitForRun,
      now,
      reportFailure,
      notificationTarget,
      readOwner,
      idleMs,
    });
    this.queue = Promise.resolve();
  }
  exclusive(operation) {
    const result = this.queue.then(operation);
    this.queue = result.catch(() => {});
    return result;
  }
  async save(task) {
    const observation = await this.store.observe(task.id);
    if (observation.value && observation.value.revision !== task.revision) {
      throw new Error("Task changed during preparation; no effect admitted");
    }
    task.revision += 1;
    const result = await this.store.compareAndApply(task.id, observation.comparison, {
      operation: "update",
      action: "set",
      value: task,
    });
    if (result.status === "conflict") {
      throw new Error("Task ownership conflict");
    }
    return task;
  }
  async records() {
    return (await this.store.entries()).map((entry) => entry.value);
  }
  async active(sessionKey) {
    return (await this.records()).find(
      (task) => task.sessionKey === sessionKey && !terminalStates.has(task.status),
    );
  }
  async prepare(event, context) {
    if (!businessSession(context.sessionKey)) {
      return;
    }
    const existing = await this.active(context.sessionKey);
    const provenance = context.inputProvenance;
    const delegatedTask =
      provenance?.kind === "inter_session" &&
      ["sessions_spawn", "agent_harness_task"].includes(provenance.sourceTool) &&
      !(provenance.sourceSessionKey ?? "").startsWith("agent:jcr:");
    // Native sessions_spawn currently omits inputProvenance in its launch
    // request. Accept that initial input only through current host-owned lineage,
    // never by parsing the task prompt or trusting a user-provided role marker.
    let nativeAssignment = false;
    if (!provenance && !existing && resumableSession(context.sessionKey)) {
      const entry = await this.readOwner({
        agentId: context.agentId,
        sessionKey: context.sessionKey,
      });
      nativeAssignment = Boolean(
        entry &&
        entry.sessionId === context.sessionId &&
        businessSession(entry.spawnedBy) &&
        !entry.abortedLastRun,
      );
    }
    if (provenance?.kind !== "external_user" && !delegatedTask && !nativeAssignment) {
      return existing;
    }
    const currentMessage = event.currentUserMessage;
    if (typeof currentMessage !== "string" || !event.currentUserMessageId) {
      throw new Error(
        "Fresh command lacks host-owned message identity; follow-through enrollment unavailable",
      );
    }
    if (/^\s*(?:\/stop|stop|cancel(?: (?:this|the) task)?)\s*[.!]?\s*$/i.test(currentMessage)) {
      if (existing) {
        await this.finish(existing, "canceled", "Canceled by the requester");
      }
      return;
    }
    if (existing) {
      return existing;
    }
    const id = digest(`${context.sessionKey}\0${event.currentUserMessageId}`);
    const prior = await this.store.lookup(id);
    // A repeated admission never resurrects a canceled or terminal command.
    if (prior) {
      return terminalStates.has(prior.status) ? undefined : prior;
    }
    if (!context.sessionId) {
      throw new Error("Command owner has no session identity");
    }
    const task = {
      id,
      revision: 0,
      sessionKey: context.sessionKey,
      sessionId: context.sessionId,
      agentId: context.agentId ?? context.sessionKey.split(":")[1],
      sourceMessageId: event.currentUserMessageId,
      status: "running",
      goal: bounded(currentMessage),
      summary: "New business request awaiting classification",
      createdAt: this.now(),
      updatedAt: this.now(),
      dependencies: [],
      continuation: null,
      ownerRunId: context.runId ?? null,
    };
    await this.store.registerIfAbsent(id, task);
    return await this.store.lookup(id);
  }
  async adopt(parameters) {
    const { sessionKey, expectedSessionId, originalMessageId, originalStartedAt, goal, runIds } =
      parameters;
    if (
      !resumableSession(sessionKey) ||
      typeof expectedSessionId !== "string" ||
      !expectedSessionId ||
      typeof originalMessageId !== "string" ||
      !originalMessageId ||
      typeof goal !== "string" ||
      !goal.trim() ||
      !Number.isFinite(originalStartedAt) ||
      originalStartedAt > this.now()
    ) {
      throw new Error(
        "Adoption requires one exact original business task and its authorization identity",
      );
    }
    if (
      !Array.isArray(runIds) ||
      !runIds.length ||
      runIds.length > 8 ||
      runIds.some((runId) => !/^[a-f0-9-]{36}$/.test(runId))
    ) {
      throw new Error("Adoption requires exact existing native dependency run IDs");
    }
    const facts = await this.gateway.readSessionFacts({ sessionKeys: [sessionKey] });
    const owner = facts.sessions.find((session) => session.key === sessionKey);
    const entry = await this.readOwner({ agentId: sessionKey.split(":")[1], sessionKey });
    if (
      facts.warnings?.length ||
      !owner ||
      owner.archived ||
      owner.sessionId !== expectedSessionId ||
      !entry ||
      entry.abortedLastRun === true ||
      entry.abortCutoffTimestamp >= originalStartedAt
    ) {
      throw new Error("Original owner identity/cancellation is not current; adoption refused");
    }
    const existing = await this.active(sessionKey);
    if (existing) {
      return existing;
    }
    const id = digest(`${sessionKey}\0${originalMessageId}`);
    const previous = await this.store.lookup(id);
    if (previous) {
      throw new Error("A previously enrolled task cannot be resurrected by adoption");
    }
    const task = {
      id,
      revision: 0,
      sessionKey,
      sessionId: expectedSessionId,
      agentId: sessionKey.split(":")[1],
      sourceMessageId: originalMessageId,
      createdAt: originalStartedAt,
      updatedAt: this.now(),
      goal: bounded(goal),
      summary: "Explicit operator adoption of an existing authorized dependency wait",
      classified: true,
      status: "waiting_dependency",
      dependencies: [...new Set(runIds)],
      continuation: null,
      ownerRunId: null,
      adoption: { admittedAt: this.now(), originalStartedAt },
    };
    await this.store.registerIfAbsent(id, task);
    return await this.store.lookup(id);
  }
  async stall(task, summary) {
    if (task.status === "stalled") {
      return task;
    }
    task.status = "stalled";
    task.summary = bounded(summary);
    task.stallIncidents = (task.stallIncidents ?? 0) + 1;
    task.notification = {
      state: "pending",
      incident: `${task.id}:stalled:${task.stallIncidents}`,
      attempts: 0,
    };
    await this.save(task);
    return task;
  }
  async readCompletionReceipt(context, parameters) {
    if (!parameters.evidencePath || !/^[a-f0-9]{64}$/.test(parameters.sha256 ?? "")) {
      throw new Error("Completion requires a canonical verification receipt and its exact SHA-256");
    }
    if (context.sandboxed || !context.workspaceDir) {
      throw new Error("Receipt verification requires the owner workspace");
    }
    const root = await realpath(context.workspaceDir);
    const path = await realpath(parameters.evidencePath);
    const local = relative(root, path);
    if (!local || local.startsWith("..") || isAbsolute(local)) {
      throw new Error("Receipt must remain inside the owner workspace");
    }
    const bytes = await readFile(path);
    if (digest(bytes) !== parameters.sha256) {
      throw new Error("Completion receipt digest does not match");
    }
    const receipt = JSON.parse(bytes.toString("utf8"));
    if (
      receipt.schema !== "business-task-completion/1" ||
      receipt.taskId !== parameters.taskId ||
      receipt.canonicalLandingVerified !== true ||
      receipt.endToEndVerified !== true ||
      typeof receipt.canonicalLocation !== "string" ||
      !receipt.canonicalLocation.trim() ||
      typeof receipt.canonicalRevision !== "string" ||
      !receipt.canonicalRevision.trim() ||
      !Number.isSafeInteger(receipt.expectedCount) ||
      receipt.expectedCount < 0 ||
      receipt.expectedCount !== receipt.observedCount ||
      !Array.isArray(receipt.remainingActions) ||
      receipt.remainingActions.length
    ) {
      throw new Error(
        "A plan, test-only receipt, or incomplete canonical delivery is not completed work",
      );
    }
    return { path, sha256: parameters.sha256, verifiedAt: this.now(), canonical: receipt };
  }
  async review(context, parameters) {
    if (!businessSession(context.sessionKey) || !context.sessionId) {
      throw new Error("Independent review is unavailable in this lane");
    }
    context.assertInvocationCurrent();
    const task = await this.store.lookup(parameters.taskId);
    if (
      !task ||
      task.status !== "review_pending" ||
      task.sessionKey === context.sessionKey ||
      task.sessionId === context.sessionId
    ) {
      throw new Error(
        "Completion requires a different live reviewer session and a pending owner receipt",
      );
    }
    if (await this.suppressStoppedTask(task)) {
      throw new Error("Canceled work cannot be approved");
    }
    const bytes = await readFile(task.verification.path);
    if (digest(bytes) !== task.verification.sha256) {
      throw new Error("Owner completion receipt changed after submission");
    }
    if (typeof parameters.summary !== "string" || !parameters.summary.trim()) {
      throw new Error("Independent review findings are required");
    }
    context.assertInvocationCurrent();
    task.review = {
      sessionKey: context.sessionKey,
      sessionId: context.sessionId,
      reviewedAt: this.now(),
      summary: bounded(parameters.summary),
    };
    if (parameters.decision === "approve") {
      return await this.finish(task, "done", task.summary);
    }
    if (parameters.decision !== "reject") {
      throw new Error("Review decision must be approve or reject");
    }
    return await this.stall(
      task,
      `Independent review requires correction: ${bounded(parameters.summary)}`,
    );
  }
  async finish(task, status, summary) {
    task.status = status;
    task.summary = bounded(summary);
    task.updatedAt = this.now();
    if (status === "done") {
      task.status = "delivery_pending";
    }
    if (!["canceled", "conversation"].includes(status)) {
      task.notification = { state: "pending", incident: `${task.id}:${status}`, attempts: 0 };
    } else {
      task.notification = null;
    }
    await this.save(task);
    return task;
  }
  async checkpoint(context, parameters) {
    if (!businessSession(context.sessionKey)) {
      throw new Error("Business follow-through is not available in this lane");
    }
    context.assertInvocationCurrent();
    const task = await this.store.lookup(parameters.taskId);
    if (!task || task.sessionKey !== context.sessionKey || task.sessionId !== context.sessionId) {
      throw new Error("Task does not belong to this live session");
    }
    if (terminalStates.has(task.status)) {
      throw new Error("Terminal task cannot be resumed by a late result");
    }
    const action = parameters.action;
    if (action === "conversation" && task.classified) {
      throw new Error("A conversational side question cannot dismiss an owned command");
    }
    const allowed = [
      "progress",
      "wait_dependency",
      "wait_approval",
      "done",
      "blocked",
      "failed",
      "canceled",
      "conversation",
    ];
    if (!allowed.includes(action)) {
      throw new Error("Unknown task action");
    }
    if (typeof parameters.summary !== "string" || !parameters.summary.trim()) {
      throw new Error("A concise outcome is required");
    }
    if (action === "done") {
      task.verification = await this.readCompletionReceipt(context, parameters);
      context.assertInvocationCurrent();
      task.status = "review_pending";
      task.classified = true;
      task.summary = bounded(parameters.summary);
      task.updatedAt = this.now();
      task.notification = null;
      await this.save(task);
      return task;
    }
    context.assertInvocationCurrent();
    if (terminalStates.has(action)) {
      return await this.finish(task, action, parameters.summary);
    }
    task.classified = true;
    task.notification = null;
    task.summary = bounded(parameters.summary);
    task.status =
      action === "progress"
        ? "running"
        : action === "wait_approval"
          ? "waiting_approval"
          : "waiting_dependency";
    task.ownerRunId = context.runId ?? null;
    task.updatedAt = this.now();
    task.continuation = null;
    if (action === "wait_dependency") {
      if (
        !Array.isArray(parameters.runIds) ||
        parameters.runIds.length < 1 ||
        parameters.runIds.length > 8 ||
        parameters.runIds.some((runId) => !/^[a-f0-9-]{36}$/.test(runId))
      ) {
        throw new Error("Dependency wait requires one to eight exact native run IDs");
      }
      task.dependencies = [...new Set(parameters.runIds)];
    } else {
      task.dependencies = [];
    }
    await this.save(task);
    return task;
  }
  async suppressStoppedTask(task) {
    const entry = await this.readOwner({ agentId: task.agentId, sessionKey: task.sessionKey });
    if (entry?.abortCutoffTimestamp >= task.createdAt) {
      await this.finish(task, "canceled", "Native stop cutoff canceled the command");
      return true;
    }
    return false;
  }
  async end(context, event) {
    if (!businessSession(context.sessionKey)) {
      return;
    }
    const task = await this.active(context.sessionKey);
    if (!task || task.sessionId !== context.sessionId) {
      return;
    }
    if (await this.suppressStoppedTask(task)) {
      return;
    }
    if (!event.success) {
      return await this.finish(
        task,
        "failed",
        "The task owner encountered a model or runtime error. Operator review is required.",
      );
    }
    if (task.status === "running") {
      return await this.stall(
        task,
        "The owner turn ended without verified completion or a registered dependency. No business action was replayed.",
      );
    }
  }
  async notify(task) {
    const notification = task.notification;
    if (!notification || ["delivered", "reported"].includes(notification.state)) {
      return;
    }
    if (await this.suppressStoppedTask(task)) {
      return;
    }
    if (notification.state === "sending" || notification.state === "unknown") {
      notification.state = "reported";
      await this.save(task);
      this.reportFailure(
        new Error(
          `Task ${task.id}: notification delivery uncertain; inspect the native delivery receipt before retrying`,
        ),
      );
      return;
    }
    if (notification.attempts >= 3) {
      notification.state = "reported";
      await this.save(task);
      this.reportFailure(
        new Error(`Task ${task.id}: notification unavailable after three pre-admission checks`),
      );
      return;
    }
    notification.attempts += 1;
    if (!(await this.gateway.isAvailable())) {
      await this.save(task);
      this.reportFailure(new Error(`Task ${task.id}: Gateway notification capability unavailable`));
      return;
    }
    // Persist before the external effect. A crash with an uncertain outcome must
    // not resend a possibly delivered Telegram message after restart.
    notification.state = "sending";
    await this.save(task);
    try {
      const receipt = await this.gateway.request("send", {
        channel: "telegram",
        accountId: "default",
        to: this.notificationTarget,
        agentId: "main",
        message: `Business task ${task.status === "delivery_pending" ? "completed" : task.status}: ${task.summary}\nOwner: ${task.agentId}. Task: ${task.id.slice(0, 12)}. Goal: ${task.goal.slice(0, 180)}`,
        idempotencyKey: `business-follow-through:${notification.incident}`,
      });
      if (!receipt?.messageId && !receipt?.messageIds?.length) {
        throw new Error("No observed message receipt");
      }
      notification.state = "delivered";
      notification.receipt = receipt;
      if (task.status === "delivery_pending") {
        task.status = "done";
      }
      await this.save(task);
    } catch {
      notification.state = "unknown";
      await this.save(task);
      this.reportFailure(
        new Error(
          `Task ${task.id}: notification failed or receipt uncertain; no automatic duplicate send`,
        ),
      );
    }
  }
  async inspect(task) {
    if (terminalStates.has(task.status) || ["delivery_pending", "stalled"].includes(task.status)) {
      return await this.notify(task);
    }
    if (await this.suppressStoppedTask(task)) {
      return;
    }
    const { sessions, warnings } = await this.gateway.readSessionFacts({
      sessionKeys: [task.sessionKey],
    });
    if (warnings?.length) {
      throw new Error("Owner facts are unavailable; no continuation admitted");
    }
    const owner = sessions.find((session) => session.key === task.sessionKey);
    if (!owner || owner.sessionId !== task.sessionId || owner.archived) {
      await this.finish(
        task,
        "blocked",
        "The original task owner disappeared or was replaced. No work was replayed.",
      );
      return await this.notify(task);
    }
    if (task.status === "waiting_approval") {
      return;
    } // An approval wait is not a stalled worker.
    if (task.status === "waiting_dependency") {
      const dependencies = [];
      for (const runId of task.dependencies) {
        dependencies.push({ runId, result: await this.waitForRun({ runId, timeoutMs: 1 }) });
      }
      const failed = dependencies.find(
        ({ result }) => ["error", "timeout"].includes(result.status) && result.endedAt,
      );
      if (failed) {
        await this.finish(
          task,
          "failed",
          `A registered dependency failed (${failed.runId}). The owner must review before any retry.`,
        );
        return await this.notify(task);
      }
      const completed = dependencies.filter(
        ({ result }) => result.status === "ok" && result.yielded !== true,
      );
      const paused = dependencies.some(({ result }) => result.yielded === true);
      // A completed prerequisite plus a message-paused sibling is the reproduced
      // frozen-batch cycle. Wake the original task owner, never create a coordinator.
      const activeDependency = dependencies.some(
        ({ result }) => result.status === "pending" && result.yielded !== true,
      );
      const ready = completed.length === dependencies.length || (completed.length > 0 && paused);
      if (ready && owner.run !== "active" && !task.continuation) {
        if (!resumableSession(task.sessionKey)) {
          await this.finish(
            task,
            "blocked",
            "Dependency results are ready, but automatic continuation cannot inject into a person’s chat. The controlling operator must resume the existing task.",
          );
          return await this.notify(task);
        }
        task.continuation = { state: "sending", completed: completed.map(({ runId }) => runId) };
        await this.save(task);
        // Refresh cancellation, session identity, and turn liveness immediately before effect.
        const current = await this.store.lookup(task.id);
        const fresh = await this.gateway.readSessionFacts({ sessionKeys: [task.sessionKey] });
        if (await this.suppressStoppedTask(task)) {
          return;
        }
        if (
          fresh.warnings?.length ||
          current?.status !== "waiting_dependency" ||
          fresh.sessions[0]?.sessionId !== task.sessionId ||
          fresh.sessions[0]?.run === "active"
        ) {
          return;
        }
        try {
          task.continuation.receipt = await this.gateway.request("sessions.send", {
            key: task.sessionKey,
            agentId: task.agentId,
            timeoutMs: 0,
            idempotencyKey: `business-follow-through:${task.id}:${task.updatedAt}:dependency`,
            message: `Registered task ${task.id}: native dependency results are ready (${task.continuation.completed.join(", ")}). ${paused ? "A message-paused sibling may be holding the completion batch." : ""} Reconcile retained results through the original owner; preserve cancellation and approval gates. Do not repeat completed writes or create another coordinator. Record progress, an approval wait, or a verified terminal outcome with business_task_checkpoint.`,
          });
          task.continuation.state = "admitted";
          task.updatedAt = this.now();
          await this.save(task);
        } catch {
          await this.stall(
            task,
            "The native owner continuation was rejected or uncertain. The controlling operator must inspect the original task; no retry or replacement owner was started.",
          );
          await this.notify(task);
        }
        return;
      }
      if (!ready && activeDependency) {
        return;
      }
    }
    if (this.now() - task.updatedAt >= this.idleMs) {
      await this.stall(
        task,
        owner.run === "active"
          ? "The owner stopped recording task progress within its lease. Operator inspection is required; the running worker was not interrupted."
          : "The owner is idle while its task is incomplete. No business write was replayed.",
      );
      await this.notify(task);
    }
  }
  async sweep() {
    for (const task of await this.records()) {
      try {
        await this.inspect(task);
      } catch (error) {
        this.reportFailure(error);
        // Observation failures must not leave an owned command silently waiting.
        // Keep approval/review gates and terminal outcomes intact. If storage or
        // cancellation reads also fail, service health remains the honest fallback.
        if (["running", "waiting_dependency"].includes(task.status)) {
          try {
            await this.stall(
              task,
              "Native task observation failed. The original owner is retained; the operator must inspect before continuation. No business write was replayed.",
            );
            await this.notify(task);
          } catch (notificationError) {
            this.reportFailure(notificationError);
          }
        }
      }
    }
  }
}
