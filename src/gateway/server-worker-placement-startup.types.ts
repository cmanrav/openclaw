import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { GatewayScheduler } from "../infra/gateway-scheduler.js";
import { emitSessionsChanged } from "./server-methods/session-change-event.js";
import type { WorkerPlacementSessionWorkCancellation } from "./server-worker-placement-cancel.js";
import type { NodeWorkerBundleRetention } from "./worker-environments/node-workspace-retain-coordinator.js";
import type { WorkerSessionPlacementRecord } from "./worker-environments/placement-record.js";
import type { WorkerSessionPlacementStore } from "./worker-environments/placement-store.js";
import type { WorkerEnvironmentService } from "./worker-environments/service.js";

export type GatewayWorkerPlacementRuntimeParams = {
  scheduler: GatewayScheduler;
  placements: WorkerSessionPlacementStore;
  initialPlacements: readonly WorkerSessionPlacementRecord[];
  getCommittedRuntimeConfig: () => OpenClawConfig;
  environments: WorkerEnvironmentService;
  gatewayNamespace: string;
  nodeWorkerBundleRetention?: NodeWorkerBundleRetention;
  persistAbandonedPartial?: (request: {
    sessionId: string;
    sessionKey: string;
    agentId: string;
    runId: string;
  }) => Promise<void>;
  getSessionChangeContext?: () => Parameters<typeof emitSessionsChanged>[0] | undefined;
  cancelSessionWork: WorkerPlacementSessionWorkCancellation;
  revokeSessionAuthority: (request: { sessionId: string; sessionKeys: readonly string[] }) => void;
  info?: (message: string) => void;
  warn: (message: string) => void;
};
