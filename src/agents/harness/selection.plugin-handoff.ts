import { isHostScopedAgentToolActive } from "../agent-tools.ring-zero-context.js";
import type { EmbeddedRunAttemptInternalParams } from "../embedded-agent-runner/run/internal-params.js";
import type { EmbeddedRunAttemptParams } from "../embedded-agent-runner/run/types.js";
import {
  unwrapModelHeaderSentinelsForProviderEgress,
  unwrapSecretSentinelsForProviderEgress,
} from "../provider-secret-egress.js";
import { isRuntimeToolAllowed, isToolAllowedByPolicies } from "../tool-policy-match.js";
import { normalizeToolPolicyName } from "../tool-policy.js";
import type { SystemAgentToolOptions } from "../tools/system-agent-tool.js";
import {
  preparePluginHarnessToolPolicies,
  resolvePluginHarnessDenyAllToolPolicyPrompt,
  type ResolvedPluginHarnessToolPolicies,
} from "./execution-environment.js";
import { createAgentHarnessHostCapabilities } from "./host-capability.js";
import { assertPluginHarnessConversationToolPolicySupport } from "./support.js";
import type { AgentHarness } from "./types.js";

export function isSystemAgentOnlyAllowlist(toolsAllow: readonly string[] | undefined): boolean {
  return toolsAllow?.length === 1 && normalizeToolPolicyName(toolsAllow[0] ?? "") === "openclaw";
}

export function withoutInternalHarnessAuthority(
  params: EmbeddedRunAttemptParams,
  harness: AgentHarness,
  builtIn: boolean,
  ownerPluginId: string | undefined,
): {
  params: import("./types.js").AgentHarnessAttemptParamsV2;
  closeHostCapabilities: () => void;
  setInputAttachmentReadAllowed: (allowed: boolean) => void;
  runWithHostScope: <T>(run: () => Promise<T>) => Promise<T>;
} {
  if (builtIn) {
    return {
      // The built-in harness is the internal owner of this authority. Only
      // plugin handoffs receive the projected public attempt shape below.
      params: {
        ...params,
        operationalRunInstance: params.admittedRunContext.operationalRunInstance,
        // SAFETY: The built-in owner receives admitted internal params plus its own operational instance.
      } as import("./types.js").AgentHarnessAttemptParamsV2,
      closeHostCapabilities: () => {},
      setInputAttachmentReadAllowed: () => {},
      runWithHostScope: (run) => run(),
    };
  }
  const pluginParams = withoutPluginHarnessPrivateState(params);
  const host = createAgentHarnessHostCapabilities({
    attempt: params,
    requiredNodeCommands: harness.cloudPlacement?.devicePlacement?.requiredNodeCommands,
    nativeModelPolicySupport: harness.nativeModelPolicySupport,
    pluginId:
      ownerPluginId ??
      (() => {
        throw new Error(`Agent harness ${harness.id} has no authoritative registry owner.`);
      })(),
  });
  return {
    params: { ...pluginParams, hostCapabilities: host.capabilities },
    closeHostCapabilities: host.close,
    setInputAttachmentReadAllowed: host.setInputAttachmentReadAllowed,
    runWithHostScope: host.runWithScope,
  };
}

export function prepareHarnessFinalizationParams(
  params: EmbeddedRunAttemptParams & { systemAgentTool?: SystemAgentToolOptions },
  builtIn: boolean,
): import("./types.js").AgentHarnessSettledTurnFinalizationAttemptParams<
  import("./types.js").AgentHarnessAttemptParamsV2
> {
  const {
    hostCapabilities: _hostCapabilities,
    systemAgentTool: _systemAgentTool,
    ...withoutCapabilities
  } = params;
  if (builtIn) {
    return withoutCapabilities;
  }
  const pluginParams = withoutPluginHarnessPrivateState(withoutCapabilities);
  const boundary = "plugin harness finalization handoff";
  return {
    ...pluginParams,
    model: unwrapModelHeaderSentinelsForProviderEgress(pluginParams.model, boundary),
    resolvedApiKey: pluginParams.resolvedApiKey
      ? unwrapSecretSentinelsForProviderEgress(pluginParams.resolvedApiKey, boundary)
      : pluginParams.resolvedApiKey,
  };
}

function withoutPluginHarnessPrivateState(
  params: EmbeddedRunAttemptInternalParams,
): Omit<import("./types.js").AgentHarnessAttemptParamsV2, "hostCapabilities"> {
  // Keep mutable host-owned state behind one projection for every plugin handoff;
  // separate projections can drift and expose authority on less common operations.
  const {
    admittedRunContext: _admittedRunContext,
    runtimePluginToolGrant: _runtimePluginToolGrant,
    assistantErrorTranscript: _assistantErrorTranscript,
    compactionCountOwner: _compactionCountOwner,
    completionCheck: _completionCheck,
    preparedSessionTarget: _preparedSessionTarget,
    onContextAccountingEvent: _onContextAccountingEvent,
    onCompactionRequestBudget: _onCompactionRequestBudget,
    contextEngineLogicalTurnLease: _contextEngineLogicalTurnLease,
    hostCapabilities: _hostCapabilities,
    onContextEngineTurnCandidate: _onContextEngineTurnCandidate,
    trajectoryRecorder: _trajectoryRecorder,
    inputAttachmentMedia: _inputAttachmentMedia,
    supportsTurnScopedToolRestrictions: _supportsTurnScopedToolRestrictions,
    __openclawSourceReplyDeliveryRuntime: _sourceReplyDeliveryRuntime,
    ...pluginParams
    // SAFETY: The optional host-private delivery runtime is removed as unknown, never interpreted.
  } = params as EmbeddedRunAttemptInternalParams & {
    __openclawSourceReplyDeliveryRuntime?: unknown;
  };
  return pluginParams;
}

export async function preparePluginHarnessParams(
  params: import("./types.js").AgentHarnessAttemptParamsV2,
  harness: AgentHarness,
  nativePermissionsConsented: boolean,
  setInputAttachmentReadAllowed: (allowed: boolean) => void,
): Promise<import("./types.js").AgentHarnessAttemptParamsV2> {
  const boundary = "plugin harness handoff";
  const resolvedApiKey = params.resolvedApiKey
    ? unwrapSecretSentinelsForProviderEgress(params.resolvedApiKey, boundary)
    : params.resolvedApiKey;
  const model = unwrapModelHeaderSentinelsForProviderEgress(params.model, boundary);
  const preparedParams =
    model === params.model && resolvedApiKey === params.resolvedApiKey
      ? params
      : { ...params, model, resolvedApiKey };
  const policies = await preparePluginHarnessToolPolicies(
    preparedParams,
    harness.conversationToolPolicySupport === "exact"
      ? harness.conversationToolPolicySafeDenyTools
      : undefined,
    harness.conversationToolPolicyNativeTools,
  );
  if (policies.requiresLiveToolAuthority) {
    // Native-runtime consent does not waive a separate revocable delegation grant.
    assertPluginHarnessConversationToolPolicySupport(harness, true);
  }
  const policyParams = {
    ...preparedParams,
    pluginHarnessToolPolicySafeDeniedTools:
      policies.safeDeniedToolNames.length > 0 ? policies.safeDeniedToolNames : undefined,
    pluginHarnessToolPolicyRestricted: policies.toolPolicyRestricted,
  };
  const effectiveParams = nativePermissionsConsented
    ? policyParams
    : applyPluginHarnessDenyAllToolPolicy(policyParams, policies);
  setInputAttachmentReadAllowed(
    isRuntimeToolAllowed("read", effectiveParams.toolsAllow) &&
      isRuntimeToolAllowed("read", effectiveParams.toolExecutionAllow) &&
      isToolAllowedByPolicies("read", [
        policies.senderPolicy,
        policies.groupPolicy,
        ...policies.runtimePolicies,
      ]),
  );
  return effectiveParams;
}

function applyPluginHarnessDenyAllToolPolicy(
  params: import("./types.js").AgentHarnessAttemptParamsV2,
  policies: ResolvedPluginHarnessToolPolicies,
): import("./types.js").AgentHarnessAttemptParamsV2 {
  if (isHostScopedAgentToolActive("openclaw") && isSystemAgentOnlyAllowlist(params.toolsAllow)) {
    return params;
  }
  const prompt = resolvePluginHarnessDenyAllToolPolicyPrompt(policies);
  if (!prompt) {
    return params;
  }
  return {
    ...params,
    toolsAllow: [],
    extraSystemPrompt: appendPluginHarnessToolPolicyPrompt(params.extraSystemPrompt, prompt),
  };
}

function appendPluginHarnessToolPolicyPrompt(existing: string | undefined, prompt: string): string {
  const trimmed = existing?.trim();
  if (!trimmed) {
    return prompt;
  }
  return trimmed.includes(prompt) ? trimmed : `${trimmed}\n\n${prompt}`;
}
