import { prepareGoalChatSendRetry } from "./chat-send-goal-retry.js";
import type { ChatSendAdmissionParams } from "./chat-send-pre-admission.types.js";
import {
  createPendingChatSendReservationAccess,
  inspectGoalChatSendRetry,
} from "./chat-send-reservation.js";
import {
  admitChatSendUploads,
  consumeChatSendAdmissionRetry,
  prepareChatSendAdmissionRetry,
} from "./chat-send-work-admission.js";
export function reserveChatSendAdmission(
  params: ChatSendAdmissionParams,
  preparedGoalRetry: Awaited<ReturnType<typeof prepareGoalChatSendRetry>> | undefined,
  preparedRetry: Awaited<ReturnType<typeof prepareChatSendAdmissionRetry>>,
  pendingReservation: ReturnType<typeof createPendingChatSendReservationAccess>,
  cachedMeta: { cached: boolean; runId: string },
) {
  const { request, respond, context, client } = params;
  const { p } = request;

  params.assertCurrent?.();
  const goalRetry = inspectGoalChatSendRetry({ ...params, prepared: preparedGoalRetry });
  if (goalRetry.kind !== "new") {
    if (goalRetry.kind === "replay") {
      respond(true, { ...goalRetry.receipt, replayed: true }, undefined, cachedMeta);
    }
    return undefined;
  }
  const retryComparison = consumeChatSendAdmissionRetry(params, preparedRetry);
  if (retryComparison === false) {
    return undefined;
  }
  const uploadAdmission = admitChatSendUploads({ params: p, client, context, respond });
  if (!uploadAdmission.ok) {
    return undefined;
  }
  params.assertCurrent?.();
  pendingReservation.reserve();
  return { retryComparison, uploadAdmission };
}
