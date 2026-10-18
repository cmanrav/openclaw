import { describe, expect, it, vi } from "vitest";
import { classifyEmbeddedAgentRunResultForModelFallback } from "../../agents/embedded-agent-runner/result-fallback-classifier.js";
import type { EmbeddedAgentRunResult } from "../../agents/embedded-agent-runner/types.js";
import {
  beginRestartRecoveryTerminalDelivery,
  completeRestartRecoveryTerminalDelivery,
} from "../../config/sessions/restart-recovery-receipt.js";
import { loadSessionEntry, replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import { useTempSessionsFixture } from "../../config/sessions/test-helpers.js";
import type { FollowupRun } from "./queue/types.js";
import { recoverStrandedReplyBeforeCompletion } from "./stranded-reply-inline-recovery.js";
import { resolveStrandedReplyRecovery } from "./stranded-reply-recovery.js";
import { createMockFollowupRun } from "./test-helpers.js";

const finalText =
  "The requested work has completed. Here are the verified results and remaining actions for the original requester, which must be delivered through the message tool.";
const original: EmbeddedAgentRunResult = {
  payloads: [{ text: finalText }],
  meta: {
    durationMs: 10,
    finalAssistantVisibleText: finalText,
    agentMeta: {
      sessionId: "session",
      provider: "openai",
      model: "test",
      usage: { input: 10, output: 2 },
    },
  },
  successfulCronAdds: 1,
  messagingToolSentTargets: [
    { tool: "message", provider: "telegram", to: "123", sourceReplyFinal: false },
  ],
};
function options() {
  return {
    result: structuredClone(original),
    followupRun: createMockFollowupRun({ sourceTurnId: "source", toolsAllow: ["message", "exec"] }),
    sourceReplyDeliveryMode: "message_tool_only" as const,
    sendPolicyDenied: false,
    isHeartbeat: false,
    isRoomEvent: false,
    hasDeliveryClaim: true,
    messageToolAllowed: true,
    hasPendingDelivery: false,
    abortSignal: new AbortController().signal,
    recover: vi.fn(async (_retry: FollowupRun): Promise<EmbeddedAgentRunResult> => ({
      meta: {
        durationMs: 5,
        agentMeta: {
          sessionId: "session",
          provider: "openai",
          model: "test",
          usage: { input: 3, output: 1 },
        },
      },
      sourceReplyDeliveryState: "delivered",
      didDeliverSourceReplyViaMessageTool: true,
    })),
  };
}

describe("admitted stranded-reply recovery", () => {
  const fixture = useTempSessionsFixture("inline-source-delivery-");
  it("settles the actual terminal-send guard before original source retirement", async () => {
    const scope = {
      sessionKey: "agent:main:telegram:direct:123",
      storePath: fixture.storePath(),
      sessionId: "session",
      sourceTurnId: "source",
      toolCallId: "final-send",
    };
    await replaceSessionEntry(scope, {
      sessionId: "session",
      updatedAt: 1,
      restartRecoveryDeliveryRunId: "original-run",
      restartRecoveryDeliverySourceRunId: "source",
    });
    const params = options();
    let recoveryFailure: unknown;
    params.recover.mockImplementation(async (retry) => {
      try {
        expect(retry.sourceTurnId).toBe("source");
        expect(retry.toolsAllow).toEqual(["message"]);
        expect(retry.prompt).toContain(finalText);
        expect(retry.userTurnTranscriptRecorder).toBeUndefined();
        expect(loadSessionEntry(scope)?.restartRecoveryTerminalRunIds).toBeUndefined();
        expect(await beginRestartRecoveryTerminalDelivery(scope)).toBe("started");
        expect(await beginRestartRecoveryTerminalDelivery(scope)).toBe("delivery-ambiguous");
        expect(await completeRestartRecoveryTerminalDelivery(scope)).toBe("recorded");
        return {
          meta: { durationMs: 5 },
          sourceReplyDeliveryState: "delivered",
          didDeliverSourceReplyViaMessageTool: true,
        };
      } catch (error) {
        recoveryFailure = error;
        throw error;
      }
    });
    const result = await recoverStrandedReplyBeforeCompletion(params);
    if (recoveryFailure) {
      throw recoveryFailure;
    }
    expect(params.recover).toHaveBeenCalledOnce();
    expect(result.sourceReplyDeliveryState).toBe("delivered");
    expect(await beginRestartRecoveryTerminalDelivery(scope)).toBe("already-delivered");
    expect(params.followupRun.strandedReplyRetry).toBe(true);
  });

  it("retains original effects and aggregates usage without treating progress as final", async () => {
    const params = options();
    const result = await recoverStrandedReplyBeforeCompletion(params);
    expect(result.successfulCronAdds).toBe(1);
    expect(result.messagingToolSentTargets).toEqual(original.messagingToolSentTargets);
    expect(result.meta.agentMeta?.usage).toMatchObject({ input: 13, output: 3 });
    expect(result.meta.durationMs).toBe(15);
  });

  it.each([
    { isHeartbeat: true },
    { isRoomEvent: true },
    { sendPolicyDenied: true },
    { hasDeliveryClaim: false },
    { messageToolAllowed: false },
    { hasPendingDelivery: true },
    { excludeMessageTool: true },
    { result: { ...original, meta: { ...original.meta, yielded: true } } },
    {
      result: {
        ...original,
        meta: { ...original.meta, error: { kind: "incomplete_turn" as const, message: "failed" } },
      },
    },
    { result: { ...original, sourceReplyDeliveryState: "delivered" as const } },
  ])("does not retry excluded execution %j", async (override) => {
    const params = { ...options(), ...override };
    if ("excludeMessageTool" in override) {
      params.followupRun.toolsAllow = ["exec"];
    }
    await recoverStrandedReplyBeforeCompletion(params);
    expect(params.recover).not.toHaveBeenCalled();
  });

  it("does not repeat business execution or queue another retry after a delivery error", async () => {
    const params = options();
    params.recover.mockRejectedValue(new Error("delivery failed"));
    expect(await recoverStrandedReplyBeforeCompletion(params)).toBe(params.result);
    const recovery = resolveStrandedReplyRecovery({
      base: params.followupRun,
      payloads: [],
      finalText,
      sourceReplyDeliveryMode: "message_tool_only",
      sendPolicyDenied: false,
      successfulSourceReplyDelivery: false,
      isHeartbeat: false,
      isRoomEvent: false,
    });
    expect(recovery.kind).toBe("diagnostic");
    await recoverStrandedReplyBeforeCompletion(params);
    expect(params.recover).toHaveBeenCalledOnce();
  });

  it.each(["error", "empty"])(
    "does not replay completed business work after returned recovery %s",
    async (kind) => {
      const params = options();
      params.result.successfulCronAdds = undefined;
      params.result.messagingToolSentTargets = undefined;
      params.recover.mockResolvedValue({
        payloads: kind === "error" ? [{ text: "rate limit", isError: true }] : [],
        meta: { durationMs: 1 },
      });
      const result = await recoverStrandedReplyBeforeCompletion(params);
      expect(result).toBe(params.result);
      expect(
        classifyEmbeddedAgentRunResultForModelFallback({
          provider: "openai",
          model: "test",
          result,
        }),
      ).toBeNull();
    },
  );

  it("honors cancellation during recovery rather than publishing its result", async () => {
    const params = options();
    const controller = new AbortController();
    params.abortSignal = controller.signal;
    params.recover.mockImplementation(async () => {
      controller.abort(new Error("cancelled"));
      throw controller.signal.reason;
    });
    await expect(recoverStrandedReplyBeforeCompletion(params)).rejects.toThrow("cancelled");
  });
});
