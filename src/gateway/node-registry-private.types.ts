import { NODE_WORKER_PRIVATE_COMMANDS } from "../infra/node-commands.js";
import type { NodeRunnerInventoryIssue } from "../infra/node-runner-inventory.js";
import type { NodeInvokeResult } from "./node-invoke.types.js";
import type { NodePairingLeaseResolution } from "./node-registry-pairing.js";
import type {
  NodeInvokeStreamController,
  PendingInvoke,
  PendingSystemRunEvent,
} from "./node-registry.invoke-stream.js";
import type {
  NodeRunnerInventoryRecord,
  NodeRunnerRegistrySession,
  NodeRunnerStatePublisher,
  NodeWorkerBundleStatusObservation,
  NodeWorkerSupervisorNodeProof,
} from "./node-runner-inventory-runtime.js";

export type PairingBoundNodeSession = NodeRunnerRegistrySession & { pairingIdentity: string };
export type NodeWorkerPrivateCommand = (typeof NODE_WORKER_PRIVATE_COMMANDS)[number];

export type NodeWorkerSupervisorTransport = {
  getCurrentNode(nodeId: string): Promise<NodeWorkerSupervisorNodeProof | undefined>;
  listCurrentNodes(): Promise<readonly NodeWorkerSupervisorNodeProof[]>;
  hasCurrentRunner(nodeId: string): boolean;
  /** Diagnostic connection presence, independent of session-host eligibility. */
  isConnected?(nodeId: string): boolean;
  getIssue?(nodeId: string): NodeRunnerInventoryIssue | undefined;
  getBundleStatus?(nodeId: string): NodeWorkerBundleStatusObservation | undefined;
  acceptBundleStatus?(
    node: NodeWorkerSupervisorNodeProof,
    observation: NodeWorkerBundleStatusObservation | undefined,
  ): boolean;
  isCurrent(
    node: NodeWorkerSupervisorNodeProof,
    requireLaunchEligibility?: boolean,
    requiredCommands?: readonly string[],
    requireCapturedExecPolicy?: boolean,
  ): boolean;
  invoke(params: {
    node: NodeWorkerSupervisorNodeProof;
    command: NodeWorkerPrivateCommand;
    params?: unknown;
    timeoutMs?: number;
    signal?: AbortSignal;
    idempotencyKey?: string;
    authorizeDispatch?: () => Promise<boolean>;
    isDispatchAuthorized: () => boolean;
    /** Completed effects may retain response custody after their dispatch snapshot changes. */
    isCompletionAuthorized?: () => boolean;
    onDispatchReady?: (invokeId: string) => void;
  }): Promise<NodeInvokeResult>;
};

export type NodeRegistryPrivateContext = {
  getNode: (nodeId: string) => PairingBoundNodeSession | undefined;
  isCommandAllowed: (nodeId: string, command: string) => boolean;
  listCurrentConnected: () => Promise<NodeRunnerRegistrySession[]>;
  getCurrentConnected: (nodeId: string) => Promise<NodeRunnerRegistrySession | undefined>;
  hasCurrentPairingStateResolver: boolean;
  resolvePairingLease: (
    node: PairingBoundNodeSession,
  ) => Promise<NodePairingLeaseResolution<PairingBoundNodeSession>>;
  pendingInvokes: Map<string, PendingInvoke>;
  invokeStreams: NodeInvokeStreamController;
  sendEventToSession: (node: NodeRunnerRegistrySession, event: string, payload: unknown) => boolean;
  rememberAuthorizedSystemRunEvent: (
    event: PendingSystemRunEvent & {
      nodeId: string;
      connId: string;
    },
  ) => void;
  publishActiveNodeContext: () => void;
};

export type GenerationBoundPendingInvoke = {
  expectedGeneration: string;
  controller: AbortController;
};

export type NodeRegistryPrivateState = {
  context: NodeRegistryPrivateContext;
  catalogRevision: number;
  runnerInventoryByConn: Map<string, NodeRunnerInventoryRecord>;
  bundleStatusByConn: Map<string, NodeWorkerBundleStatusObservation>;
  runnerState: NodeRunnerStatePublisher;
  generationBoundInvokes: WeakMap<PendingInvoke, GenerationBoundPendingInvoke>;
  workerSupervisorTransport: NodeWorkerSupervisorTransport;
};
