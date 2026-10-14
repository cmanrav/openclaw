import { attachErrorDiagnostic } from "../../infra/error-diagnostics.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import {
  placementAuthorityOwnerFor as ownerFor,
  placementAuthorityOwners as owners,
} from "./placement-authority-owner.js";
import { WorkerPlacementInventoryChangedError } from "./placement-inventory-changed-error.js";
import {
  affectsPlacementObservation,
  hasPendingPublication,
  prunePublication,
} from "./placement-read-authority.js";

export function capturePlacementObservation(pathname: string, sessionId?: string) {
  const context = captureOpenClawStateWorkerContext({ path: pathname });
  const owner = ownerFor(context.admission.identity);
  const observation = { revokedBy: new Set<string>(), indeterminate: false };
  const observations = owner.observations.get(sessionId) ?? new Set<typeof observation>();
  observations.add(observation);
  owner.observations.set(sessionId, observations);
  let released = false;
  const changedMessage =
    sessionId === undefined
      ? "Worker placement inventory changed"
      : `Session ${sessionId} placement authority changed`;
  const changed = () => {
    const error = new Error(changedMessage);
    return attachErrorDiagnostic(error, error.stack ?? changedMessage);
  };
  const assertUsable = () => {
    context.admission.assertCurrent();
    if (
      released ||
      observation.indeterminate ||
      !owner.active ||
      owners.get(owner.identity.key) !== owner
    ) {
      throw changed();
    }
  };
  const authority = {
    assertCurrent(this: void) {
      assertUsable();
      if (observation.revokedBy.size > 0 || hasPendingPublication(owner, sessionId)) {
        if (sessionId === undefined) {
          throw new WorkerPlacementInventoryChangedError(
            new Set([
              ...observation.revokedBy,
              ...[...owner.pending]
                .filter((change) => affectsPlacementObservation(change))
                .map((change) => change.sessionId),
            ]),
          );
        }
        throw changed();
      }
    },
    release(this: void) {
      released = true;
      observations.delete(observation);
      if (observations.size === 0 && owner.observations.get(sessionId) === observations) {
        owner.observations.delete(sessionId);
      }
      if (sessionId !== undefined) {
        prunePublication(owner, sessionId);
      }
    },
  };
  return { authority, observation, owner, assertUsable };
}
