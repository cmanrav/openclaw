import { resolveSendableOutboundReplyParts } from "openclaw/plugin-sdk/reply-payload";
import type { ReplyPayload } from "../reply-payload.js";
import { hasExecApprovalPayload } from "./dispatch-from-config.payloads.js";
import type { PrepareDispatchOperationReadyState } from "./dispatch-from-config.prepare-operation.js";

export function createDispatchCommentaryProgress(
  state: PrepareDispatchOperationReadyState,
  options: {
    shouldSuppressLateTextOnlyToolProgress: (payload: ReplyPayload) => boolean;
    isFinalReplyDeliveryStarted: () => boolean;
  },
) {
  const { shouldSuppressLateTextOnlyToolProgress, isFinalReplyDeliveryStarted } = options;
  const {
    params,
    ctx,
    shouldEmitVerboseProgressAsync,
    shouldRouteToOriginating,
    sendPayloadAsync,
    markInboundDedupeReplayUnsafe,
    turnLedger,
  } = state;
  const shouldSuppressProgressDelivery = async () =>
    state.sendPolicyDenied ||
    (state.suppressDelivery && !(await shouldDeliverVerboseProgressDespiteSourceSuppression()));
  // The released reply_dispatch getter retains its synchronous contract.
  const shouldSendToolSummaries = () =>
    params.replyOptions?.suppressToolProgressMessages !== true && state.shouldEmitVerboseProgress();
  const shouldSendToolSummariesAsync = async () =>
    params.replyOptions?.suppressToolProgressMessages !== true &&
    (await shouldEmitVerboseProgressAsync());
  const allowsVerboseProgressDespiteSourceSuppression = () =>
    state.suppressAutomaticSourceDelivery &&
    state.sourceReplyDeliveryMode === "message_tool_only" &&
    ctx.InboundEventKind !== "room_event" &&
    !state.sendPolicyDenied;
  const shouldDeliverVerboseProgressDespiteSourceSuppression = async () =>
    allowsVerboseProgressDespiteSourceSuppression() && (await shouldSendToolSummariesAsync());
  const shouldSuppressProgressDeliverySync = () =>
    state.sendPolicyDenied ||
    (state.suppressDelivery &&
      !(allowsVerboseProgressDespiteSourceSuppression() && shouldSendToolSummaries()));
  const shouldDeliverForcedToolProgressDespiteSourceSuppression = () =>
    allowsVerboseProgressDespiteSourceSuppression() &&
    params.replyOptions?.forceToolResultProgress === true;
  // Durable inter-tool commentary lane: with verbose progress on, preamble
  // items become standalone progress messages like tool summaries. The latest
  // text per item id is buffered (snapshot producers re-emit the same item)
  // and flushed when the producer moves on, always before the final reply.
  let pendingCommentaryProgress: { itemId?: string; text: string } | null = null;
  const flushedCommentaryItems = new Set<string>();
  const deliverCommentaryProgressMessage = async (text: string) => {
    if (!(await shouldSendToolSummariesAsync()) || (await shouldSuppressProgressDelivery())) {
      return;
    }
    if (state.isDispatchOperationAborted()) {
      return;
    }
    const payload: ReplyPayload = { text: `💬 ${text}` };
    if (shouldSuppressLateTextOnlyToolProgress(payload)) {
      return;
    }
    state.assertProgressCurrent();
    if (shouldRouteToOriginating) {
      await sendPayloadAsync(payload);
    } else {
      markInboundDedupeReplayUnsafe();
      turnLedger.sendQueued("tool", payload);
    }
  };
  const flushPendingCommentaryProgress = async () => {
    const pending = pendingCommentaryProgress;
    pendingCommentaryProgress = null;
    const text = pending?.text.trim();
    if (!text) {
      return;
    }
    if (pending?.itemId) {
      flushedCommentaryItems.add(pending.itemId);
    }
    await deliverCommentaryProgressMessage(text);
  };
  const noteCommentaryProgress = async (payload: { itemId?: string; progressText?: string }) => {
    const itemId = payload.itemId?.trim() || undefined;
    if (isFinalReplyDeliveryStarted() || (itemId && flushedCommentaryItems.has(itemId))) {
      return;
    }
    const text = payload.progressText ?? "";
    const updatesBufferedItem =
      pendingCommentaryProgress !== null &&
      ((pendingCommentaryProgress.itemId !== undefined &&
        pendingCommentaryProgress.itemId === itemId) ||
        pendingCommentaryProgress.text.trim() === text.trim());
    if (!text.trim()) {
      // Empty commentary with an item id means the producer retracted that
      // item; drop it if it has not been sent yet.
      if (updatesBufferedItem) {
        pendingCommentaryProgress = null;
      }
      return;
    }
    if (pendingCommentaryProgress && !updatesBufferedItem) {
      await flushPendingCommentaryProgress();
    }
    pendingCommentaryProgress = { itemId, text };
  };
  const shouldSuppressMessageToolOnlyTextErrorProgress = async (payload: ReplyPayload) => {
    if (
      state.sourceReplyDeliveryMode !== "message_tool_only" ||
      (await state.shouldEmitFullVerboseProgressAsync()) ||
      payload.isError !== true
    ) {
      return false;
    }
    const reply = resolveSendableOutboundReplyParts(payload);
    return !reply.hasMedia && !hasExecApprovalPayload(payload);
  };
  return {
    shouldSuppressProgressDelivery,
    shouldSuppressProgressDeliverySync,
    shouldSendToolSummaries,
    shouldSendToolSummariesAsync,
    shouldDeliverVerboseProgressDespiteSourceSuppression,
    shouldDeliverForcedToolProgressDespiteSourceSuppression,
    flushPendingCommentaryProgress,
    noteCommentaryProgress,
    shouldSuppressMessageToolOnlyTextErrorProgress,
  };
}
