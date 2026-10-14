/** Deliver drained requester waves; lifecycle owns their persisted outbox on retained run rows. */
import type { DeliveryContext } from "../../../utils/delivery-context.shared.js";
import type { SubagentRunRecord } from "../registry/subagent-registry.types.js";
import { withSubagentRequesterSource } from "./subagent-announce-delivery.runtime.js";
import { maybeWakeRequesterAfterAllChildrenSettledBound } from "./subagent-announce.requester-settle-execution.js";
import type { RequesterSettleWakeBatchCallbacks } from "./subagent-announce.requester-settle-state.js";

/** Wake top-level or yielded requesters after their descendants settle; lifecycle owns transitions. */
export async function maybeWakeRequesterAfterAllChildrenSettled(
  params: RequesterSettleWakeBatchCallbacks & {
    requesterSessionKey: string;
    requesterOrigin?: DeliveryContext;
    settledEntry: SubagentRunRecord;
    signal?: AbortSignal;
    isSourceCurrent: () => boolean;
  },
): Promise<boolean> {
  return withSubagentRequesterSource(
    params.requesterSessionKey,
    params.settledEntry.requesterAgentId,
    async (isRequesterCurrent): Promise<boolean> => {
      const guardedParams = isRequesterCurrent
        ? {
            ...params,
            isSourceCurrent: () => isRequesterCurrent() && params.isSourceCurrent(),
          }
        : params;
      return maybeWakeRequesterAfterAllChildrenSettledBound(guardedParams);
    },
  );
}
