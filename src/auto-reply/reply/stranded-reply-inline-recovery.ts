import { hasCompletedSourceReplyDeliveryEvidence } from "../../agents/embedded-agent-runner/delivery-evidence.js";
import type { EmbeddedAgentRunResult } from "../../agents/embedded-agent-runner/types.js";
import {
  createUsageAccumulator,
  mergeUsageIntoAccumulator,
  toNormalizedUsage,
} from "../../agents/embedded-agent-runner/usage-accumulator.js";
import type { SourceReplyDeliveryMode } from "../get-reply-options.types.js";
import type { FollowupRun } from "./queue/types.js";
import { resolveStrandedReplyRecovery } from "./stranded-reply-recovery.js";

/** Recover while the original admitted source still owns its terminal send receipt. */
export async function recoverStrandedReplyBeforeCompletion(params: {
  result: EmbeddedAgentRunResult;
  followupRun: FollowupRun;
  sourceReplyDeliveryMode: SourceReplyDeliveryMode | undefined;
  sendPolicyDenied: boolean;
  isHeartbeat: boolean;
  isRoomEvent: boolean;
  hasDeliveryClaim: boolean;
  messageToolAllowed: boolean;
  hasPendingDelivery: boolean;
  abortSignal: AbortSignal | undefined;
  recover: (run: FollowupRun) => Promise<EmbeddedAgentRunResult>;
}): Promise<EmbeddedAgentRunResult> {
  const original = params.result;
  if (
    !params.hasDeliveryClaim ||
    !params.messageToolAllowed ||
    params.hasPendingDelivery ||
    original.meta.aborted ||
    original.meta.error ||
    original.meta.yielded ||
    (original.meta.pendingToolCalls?.length ?? 0) > 0 ||
    params.followupRun.disableTools ||
    params.abortSignal?.aborted
  ) {
    return original;
  }
  const recovery = resolveStrandedReplyRecovery({
    base: params.followupRun,
    payloads: original.payloads ?? [],
    finalText: original.meta.finalAssistantVisibleText ?? original.meta.finalAssistantRawText ?? "",
    sourceReplyDeliveryMode: params.sourceReplyDeliveryMode,
    sendPolicyDenied: params.sendPolicyDenied,
    successfulSourceReplyDelivery: hasCompletedSourceReplyDeliveryEvidence(original),
    isHeartbeat: params.isHeartbeat,
    isRoomEvent: params.isRoomEvent,
  });
  if (recovery.kind !== "retry" || recovery.run.toolsAllow?.length === 0) {
    return original;
  }
  // The finalizers share this host-only marker: a failed inline attempt must
  // produce the existing diagnostic, never a second queued model execution.
  params.followupRun.strandedReplyRetry = true;
  params.abortSignal?.throwIfAborted();
  let recovered: EmbeddedAgentRunResult;
  try {
    recovered = await params.recover(recovery.run);
  } catch {
    params.abortSignal?.throwIfAborted();
    // The business work already completed. Do not throw into model fallback,
    // which could repeat its tools; normal finalization owns the delivery error.
    return original;
  }
  params.abortSignal?.throwIfAborted();
  // Recovery is delivery-only: a returned model failure must never send the
  // already-completed business turn through the outer fallback candidates.
  if (!hasCompletedSourceReplyDeliveryEvidence(recovered)) {
    return original;
  }
  const usage = createUsageAccumulator();
  mergeUsageIntoAccumulator(usage, original.meta.agentMeta?.usage);
  mergeUsageIntoAccumulator(usage, recovered.meta.agentMeta?.usage);
  return {
    ...original,
    ...recovered,
    meta: {
      ...recovered.meta,
      durationMs: original.meta.durationMs + recovered.meta.durationMs,
      ...(recovered.meta.agentMeta
        ? { agentMeta: { ...recovered.meta.agentMeta, usage: toNormalizedUsage(usage) } }
        : { agentMeta: original.meta.agentMeta }),
    },
    // Delivery state belongs to the recovery attempt; original progress must not
    // masquerade as its terminal answer. Other committed business effects remain.
    sourceReplyDeliveryState: recovered.sourceReplyDeliveryState,
    sourceReplyDelivered: recovered.sourceReplyDelivered,
    didDeliverSourceReplyViaMessageTool: recovered.didDeliverSourceReplyViaMessageTool,
    messagingToolSentTexts: [
      ...(original.messagingToolSentTexts ?? []),
      ...(recovered.messagingToolSentTexts ?? []),
    ],
    messagingToolSentMediaUrls: [
      ...(original.messagingToolSentMediaUrls ?? []),
      ...(recovered.messagingToolSentMediaUrls ?? []),
    ],
    messagingToolSentTargets: [
      ...(original.messagingToolSentTargets ?? []),
      ...(recovered.messagingToolSentTargets ?? []),
    ],
    messagingToolSourceReplyPayloads: [
      ...(original.messagingToolSourceReplyPayloads ?? []),
      ...(recovered.messagingToolSourceReplyPayloads ?? []),
    ],
    acceptedSessionSpawns: [
      ...(original.acceptedSessionSpawns ?? []),
      ...(recovered.acceptedSessionSpawns ?? []),
    ],
    successfulCronAdds: (original.successfulCronAdds ?? 0) + (recovered.successfulCronAdds ?? 0),
    didSendViaMessagingTool: original.didSendViaMessagingTool || recovered.didSendViaMessagingTool,
    asyncWorkStarted: original.asyncWorkStarted || recovered.asyncWorkStarted,
  };
}
