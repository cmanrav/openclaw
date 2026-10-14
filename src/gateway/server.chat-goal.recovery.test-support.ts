import { randomUUID } from "node:crypto";
import { expect, it, vi, type Mock } from "vitest";
import * as embeddedAgent from "../agents/embedded-agent.js";
import {
  listSessionParticipantsReadOnly,
  loadSessionEntry,
  patchSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import * as sessionChangeEvents from "./server-methods/session-change-event.js";
import type { GatewayClient, RespondFn } from "./server-methods/types.js";
import { readGoalChatUserMessages } from "./server.chat-goal.test-support.js";

export function registerGoalResumeRecoveryCase(params: {
  scope: () => { agentId: string; sessionKey: string; sessionId: string; storePath: string };
  profileClient: (profileId: string) => GatewayClient;
  goalStart: (message: string) => Record<string, unknown>;
  rpc: (
    method: "chat.send" | "chat.history" | "chat.abort" | "sessions.goal.update",
    params: Record<string, unknown>,
    onResponse?: RespondFn,
    client?: GatewayClient,
  ) => Promise<ReturnType<typeof vi.fn<RespondFn>>>;
  waitForModelRun: (count?: number) => Promise<void>;
  waitForDispatchEnd: () => Promise<void>;
  userMessages: () => ReturnType<typeof readGoalChatUserMessages>;
  runEmbeddedAgent: Mock<typeof embeddedAgent.runEmbeddedAgent>;
  resetModelStarted: () => void;
}) {
  const {
    scope,
    profileClient,
    goalStart,
    rpc,
    waitForModelRun,
    waitForDispatchEnd,
    userMessages,
    runEmbeddedAgent,
    resetModelStarted,
  } = params;
  it("resumes once through the real reply pipeline despite failed postcommit notification", async () => {
    const { sessionKey, sessionId } = scope();
    const objective = "Finish the release checklist";
    const profile = ensureProfileForEmail("goal-participant@example.test");
    const requestClient = profileClient(profile.id);
    const participants = () => listSessionParticipantsReadOnly(scope()).get(sessionKey) ?? [];
    expect(participants()).toEqual([]);
    const startRequest = goalStart(objective);
    const started = await rpc("chat.send", startRequest, undefined, requestClient);
    expect(started.mock.calls[0]?.[0]).toBe(true);
    await waitForModelRun();
    await waitForDispatchEnd();
    const startMessage = userMessages()[0];
    const startTimestamp =
      startMessage && "timestamp" in startMessage ? startMessage.timestamp : undefined;
    expect(startTimestamp).toEqual(expect.any(Number));
    const startParticipants = [
      {
        identity: { type: "profile", id: profile.id },
        contributionCount: 1,
        firstPromptedAt: startTimestamp,
        lastPromptedAt: startTimestamp,
      },
    ];
    // Participant persistence is a post-admission microtask, not part of the Goal ACK.
    await vi.waitFor(() => expect(participants()).toEqual(startParticipants));
    const startReplay = await rpc("chat.send", startRequest, undefined, requestClient);
    expect(startReplay.mock.calls[0]?.[1]).toMatchObject({ replayed: true });
    expect(runEmbeddedAgent).toHaveBeenCalledOnce();
    expect(participants()).toEqual(startParticipants);
    const goal = loadSessionEntry(scope())?.goal;
    expect(goal).toBeDefined();
    await patchSessionEntryCore(scope(), (entry) => ({
      status: "done",
      agentHarnessId: "openclaw",
      goal: entry.goal ? { ...entry.goal, status: "paused" } : undefined,
    }));
    expect(loadSessionEntry(scope())?.agentHarnessId).toBe("openclaw");
    const request = {
      sessionKey,
      sessionId,
      goalId: goal?.id,
      action: "resume",
      note: "Prioritize the changelog; keep /stop as quoted text.",
      operationId: "goal-resume",
      issuedAtMs: Date.now(),
    };
    resetModelStarted();
    const emit = sessionChangeEvents.emitSessionsChanged;
    const notification = vi
      .spyOn(sessionChangeEvents, "emitSessionsChanged")
      .mockImplementation((ctx, payload, options) => {
        emit(ctx, payload, options);
        if (payload.reason === "goal") {
          throw new Error("Synthetic Goal notification failure after commit");
        }
      });
    let resumed: Awaited<ReturnType<typeof rpc>>;
    try {
      resumed = await rpc("sessions.goal.update", request, undefined, requestClient);
    } finally {
      notification.mockRestore();
    }
    expect(resumed).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ status: "started", runId: "goal-resume", goalId: goal?.id }),
      undefined,
      expect.anything(),
    );
    await waitForModelRun(2);
    await waitForDispatchEnd();
    expect(participants()).toEqual(startParticipants);
    expect(loadSessionEntry(scope())?.goal?.status).toBe("active");
    expect(userMessages()).toEqual([
      expect.objectContaining({ content: objective }),
      expect.objectContaining({
        display: false,
        provenance: expect.objectContaining({ kind: "internal_system" }),
      }),
    ]);
    expect(runEmbeddedAgent.mock.calls[1]?.[0].currentInboundContext?.text).toContain(objective);
    expect(runEmbeddedAgent.mock.calls[1]?.[0].prompt).toContain(request.note);
    const history = await rpc("chat.history", { sessionKey });
    expect(history.mock.calls[0]?.[0]).toBe(true);
    const result = history.mock.calls[0]?.[1] as {
      messages?: Array<{ role?: string; content?: unknown }>;
    };
    expect(result.messages?.filter((message) => message.role === "user")).toEqual([
      expect.objectContaining({ content: objective }),
    ]);
    const replay = await rpc("sessions.goal.update", request, undefined, requestClient);
    expect(replay.mock.calls[0]?.[1]).toMatchObject({ replayed: true, runId: "goal-resume" });
    expect(runEmbeddedAgent).toHaveBeenCalledTimes(2);
    expect(userMessages()).toHaveLength(2);
    expect(participants()).toEqual(startParticipants);

    resetModelStarted();
    const next = await rpc(
      "chat.send",
      {
        sessionKey,
        sessionId,
        message: "Also review the changelog.",
        idempotencyKey: randomUUID(),
      },
      undefined,
      requestClient,
    );
    expect(next.mock.calls[0]?.[0]).toBe(true);
    await waitForModelRun(3);
    await waitForDispatchEnd();
    const nextMessage = userMessages().at(-1);
    const nextTimestamp =
      nextMessage && "timestamp" in nextMessage ? nextMessage.timestamp : undefined;
    expect(nextTimestamp).toEqual(expect.any(Number));
    await vi.waitFor(() =>
      expect(participants()).toEqual([
        { ...startParticipants[0], contributionCount: 2, lastPromptedAt: nextTimestamp },
      ]),
    );
  });
}
