import { isEmbeddedMode } from "../infra/embedded-mode.js";
import { hasMultipleSessionSharingIdentitiesNative } from "../state/user-profile-list.native.js";
import { resolveAgentDir, resolveSessionAgentIds } from "./agent-scope.js";
import { ensureAuthProfileStoreWithoutExternalProfiles } from "./auth-profiles/store-runtime.js";
import {
  resolveOpenClawPluginToolsForOptions,
  resolveOpenClawPluginToolsForOptionsAsync,
} from "./openclaw-plugin-tools.js";
import { createOpenClawToolsSteps } from "./openclaw-tools.assembly.js";
import { prepareOpenClawTools } from "./openclaw-tools.preparation.js";
import type { OpenClawToolsOptions } from "./openclaw-tools.types.js";
import {
  withPreparedToolConstruction,
  type PreparedToolConstruction,
  type ToolConstructionPreparationOptions,
} from "./tool-construction-preparation.js";
import type { AnyAgentTool } from "./tools/common.js";
import { createMessageTool, createMessageToolAsync } from "./tools/message-tool-execution.js";

export { filterToolsByClientCaps } from "./openclaw-tools.client-caps.js";
export async function createOpenClawToolsAsync(
  options?: OpenClawToolsOptions,
  preparation: ToolConstructionPreparationOptions = {},
): Promise<AnyAgentTool[]> {
  return withPreparedToolConstruction(
    options?.config,
    {
      ...preparation,
      assertCurrent: () => {
        preparation.assertCurrent?.();
        options?.assertInvocationCurrent?.();
      },
    },
    (shared) => createOpenClawToolsWithPreparation(options, shared),
  );
}

/** Coding-tool assembly retains this same scope across its construction boundary. */
export async function createOpenClawToolsWithPreparation(
  options: OpenClawToolsOptions | undefined,
  shared: PreparedToolConstruction,
): Promise<AnyAgentTool[]> {
  const {
    captured,
    delegated,
    webSearchConfigured,
    mediaTools,
    progressCardAvailable,
    personalInstructionsEnabled,
  } = await prepareOpenClawTools(options, shared);
  shared.assertCurrent();
  captured.assertInvocationCurrent?.();
  const steps = createOpenClawToolsSteps(
    captured,
    delegated,
    webSearchConfigured,
    mediaTools,
    progressCardAvailable,
    personalInstructionsEnabled,
  );
  let next = steps.next();
  while (!next.done) {
    const tools =
      "message" in next.value
        ? [await createMessageToolAsync(next.value.message)]
        : await resolveOpenClawPluginToolsForOptionsAsync(next.value.plugins);
    shared.assertCurrent();
    captured.assertInvocationCurrent?.();
    next = steps.next(tools);
  }
  return next.value;
}

/** @deprecated Use createOpenClawToolsAsync for runtime construction. */
export function createOpenClawTools(
  options?: OpenClawToolsOptions,
  preparedDelegateTools?: AnyAgentTool[],
  preparedWebSearchConfigured?: boolean,
): AnyAgentTool[] {
  const captured = { ...options };
  const { sessionAgentId } = resolveSessionAgentIds({
    sessionKey: captured.runSessionKey ?? captured.agentSessionKey,
    config: captured.config,
    agentId: captured.requesterAgentIdOverride,
  });
  captured.authProfileStore ??= ensureAuthProfileStoreWithoutExternalProfiles(
    captured.agentDir ?? resolveAgentDir(captured.config ?? {}, sessionAgentId),
    { allowKeychainPrompt: false },
  );
  const steps = createOpenClawToolsSteps(
    captured,
    preparedDelegateTools,
    preparedWebSearchConfigured,
    undefined,
    undefined,
    !isEmbeddedMode() && hasMultipleSessionSharingIdentitiesNative(),
  );
  let next = steps.next();
  while (!next.done) {
    next = steps.next(
      "message" in next.value
        ? [createMessageTool(next.value.message)]
        : resolveOpenClawPluginToolsForOptions(next.value.plugins),
    );
  }
  return next.value;
}
