import type { CodexAttemptPrompt } from "./run-attempt-prompt.js";
import type { CodexStartOrResumeThreadParams } from "./thread-lifecycle-types.js";

export function resolveCodexAttemptModelAdmission(
  prompt: CodexAttemptPrompt,
): CodexStartOrResumeThreadParams["nativeModelAdmission"] {
  const modelAdmissionSource = prompt.context.runtime.nativeToolSurfaceEnabled
    ? prompt.context.runtime.connection.params.hostCapabilities.retainSourceAuthority?.()
    : undefined;
  let nativeModelAdmission: CodexStartOrResumeThreadParams["nativeModelAdmission"];
  try {
    nativeModelAdmission = modelAdmissionSource
      ? modelAdmissionSource.modelPolicyRequired !== false
        ? "required"
        : prompt.context.runtime.connection.options.nativeHookRelay?.enabled === false
          ? "disabled"
          : "optional"
      : undefined;
  } finally {
    modelAdmissionSource?.release();
  }
  return nativeModelAdmission;
}
