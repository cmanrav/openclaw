import { FollowThrough, businessSession, configureBusinessAgents } from "./engine.mjs";

export function registerFollowThrough(api) {
  const notificationTarget = api.pluginConfig?.notificationTarget;
  if (typeof notificationTarget !== "string" || !notificationTarget.trim()) {
    throw new Error(
      "Configure the approved business operator notificationTarget before activation",
    );
  }
  // Without an `agents` list the plugin keeps its original Thor + Tax Analyst scope.
  configureBusinessAgents(api.pluginConfig?.agents);
  const store = api.runtime.state.openKeyedStoreV2({
    namespace: "business-command-tasks",
    maxEntries: 10000,
    overflowPolicy: "reject-new",
  });
  let health;
  const engine = new FollowThrough({
    store,
    gateway: api.runtime.gateway,
    notificationTarget,
    waitForRun: (parameters) => api.runtime.subagent.waitForRun(parameters),
    readOwner: (parameters) => api.runtime.agent.session.getSessionEntryAsync(parameters),
    reportFailure: (error) => {
      health?.reportFailure(error);
      api.logger.error(error.message);
    },
  });
  const serial = (operation) => engine.exclusive(operation);
  api.on(
    "before_prompt_build",
    async (event, context) =>
      serial(async () => {
        if (
          businessSession(context.sessionKey) &&
          context.toolAuthority &&
          !context.toolAuthority.allows("business_task_checkpoint")
        ) {
          throw new Error("Business task checkpoint is not in the effective tool policy");
        }
        const task = await engine.prepare(event, context);
        if (!task) {
          return;
        }
        return {
          appendContext: `Business task ownership: ${task.id}, state ${task.status}. Keep this command owned until verified completion or an explicit blocked/failed/canceled outcome. Use business_task_checkpoint before finalizing: progress while working; wait_dependency with exact OpenClaw sessions_spawn run IDs, or wait_native_result with exact native spawn_agent child labels before yielding; wait_approval only for a real human gate. Mark conversation only if this request contains no work. Submit done only with a canonical completion receipt; this records review_pending, not success. A separate live session must use business_task_review after independently checking canonical landing, counts, and the actual outcome. The service owns the one terminal notification. Original goal: ${task.goal}. Current checkpoint: ${task.summary}. For sustained work use the existing native off-chat worker/announcement path when authorized; register the correct native-result or run-ID wait before yielding and let its native result resume this owner. Do not end after a promise or require the requester to ask again. Record concise meaningful milestones; the service reports changed progress at a bounded cadence. A status question is steering, not cancellation. A new explicit approval may resolve only its exact waiting_approval gate; record progress after evaluating that current instruction, without dropping the original goal. Preserve earlier work and all action gates.`,
        };
      }),
    { requiresToolAuthority: true },
  );
  api.on("before_agent_finalize", async (_event, context) =>
    serial(async () => {
      if (!businessSession(context.sessionKey)) {
        return;
      }
      const task = await engine.active(context.sessionKey);
      if (task?.status === "running") {
        return {
          action: "revise",
          reason: "Business task is still open",
          retry: {
            instruction:
              "Continue the authorized work or record its exact dependency, approval, or terminal outcome with business_task_checkpoint. Do not claim completion from a finished turn.",
            idempotencyKey: `task-closeout:${task.id}`,
            maxAttempts: 1,
          },
        };
      }
    }),
  );
  api.on("agent_end", (event, context) => serial(() => engine.end(context, event)));
  api.registerTool(
    {
      contextVersion: 2,
      create(context) {
        if (!businessSession(context.sessionKey)) {
          return null;
        }
        return {
          name: "business_task_checkpoint",
          label: "Business task outcome",
          description:
            "Record the active command outcome, waiting dependency or approval. Never use a terminal state for merely queued work.",
          parameters: {
            type: "object",
            additionalProperties: false,
            required: ["taskId", "action", "summary"],
            properties: {
              taskId: { type: "string" },
              action: {
                type: "string",
                enum: [
                  "progress",
                  "wait_dependency",
                  "wait_native_result",
                  "wait_approval",
                  "done",
                  "blocked",
                  "failed",
                  "canceled",
                  "conversation",
                ],
              },
              summary: { type: "string", maxLength: 600 },
              runIds: { type: "array", items: { type: "string" }, maxItems: 8 },
              nativeChildren: {
                type: "array",
                items: { type: "string", maxLength: 200 },
                maxItems: 8,
              },
              evidencePath: { type: "string" },
              sha256: { type: "string" },
            },
          },
          async execute(_callId, parameters) {
            return serial(async () => {
              const task = await engine.checkpoint(context, parameters);
              return { content: [{ type: "text", text: JSON.stringify(task) }], details: task };
            });
          },
        };
      },
    },
    { names: ["business_task_checkpoint"] },
  );
  api.registerTool(
    {
      contextVersion: 2,
      create(context) {
        if (!businessSession(context.sessionKey)) {
          return null;
        }
        return {
          name: "business_task_review",
          label: "Independent business task review",
          description:
            "After independently checking canonical landing, counts and end-to-end outcome, approve or reject another session's submitted completion. A file hash alone is not proof of completion.",
          parameters: {
            type: "object",
            additionalProperties: false,
            required: ["taskId", "decision", "summary"],
            properties: {
              taskId: { type: "string" },
              decision: { type: "string", enum: ["approve", "reject"] },
              summary: { type: "string", maxLength: 600 },
            },
          },
          async execute(_callId, parameters) {
            return serial(async () => {
              const task = await engine.review(context, parameters);
              return { content: [{ type: "text", text: JSON.stringify(task) }], details: task };
            });
          },
        };
      },
    },
    { names: ["business_task_review"] },
  );
  api.registerGatewayMethod(
    "business-task-follow-through.adopt",
    async ({ params, respond }) => {
      try {
        const task = await serial(() => engine.adopt(params));
        respond(true, { taskId: task.id, status: task.status, owner: task.sessionKey });
      } catch (error) {
        respond(false, undefined, { code: "INVALID_REQUEST", message: error.message });
      }
    },
    { scope: "operator.write", sessionAccess: { mode: "write" } },
  );
  api.registerService({
    id: "business-task-follow-through",
    apiVersion: 2,
    start(context) {
      health = context.serviceHealth;
      context.scheduler.schedule({
        id: "inspect-owned-tasks",
        delayMs: 0,
        everyMs: 60000,
        run: () => serial(() => engine.sweep()),
      });
    },
    async stop() {
      await engine.queue;
      health = undefined;
    },
  });
  return engine;
}
export default {
  id: "business-task-follow-through",
  name: "Business Task Follow-through",
  register: registerFollowThrough,
};
