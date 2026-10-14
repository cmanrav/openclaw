import { randomUUID } from "node:crypto";
import path from "node:path";
import { adjustMaxTokensForThinking } from "@openclaw/ai/internal/shared";
import { withTempWorkspace } from "@openclaw/fs-safe/temp";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolvePreferredOpenClawTmpDir } from "../infra/tmp-openclaw-dir.js";
import type { Model } from "../llm/types.js";
import { prepareSystemAgentRunAdmission } from "./admitted-run-context.js";
import { resolveCliBackendConfig } from "./cli-backends.js";
import { normalizeCliModel } from "./cli-runner/helpers.js";
import { hasCliSideEffectEvidence, IsolatedCompletionError } from "./isolated-completion-output.js";
import type {
  RunIsolatedCompletionParams,
  IsolatedCompletionResult,
} from "./isolated-completion.js";
export function resolveIsolatedStreamParams(
  { answerTokenBudget, streamParams, thinkLevel }: RunIsolatedCompletionParams,
  model?: Model,
): RunIsolatedCompletionParams["streamParams"] {
  let maxTokens = answerTokenBudget ?? streamParams?.maxTokens;
  if (maxTokens === undefined) {
    return streamParams;
  }
  const modelMaxTokens = model?.maxTokens ?? Number.POSITIVE_INFINITY;
  if (answerTokenBudget !== undefined && model?.reasoning && thinkLevel !== "off") {
    maxTokens = adjustMaxTokensForThinking(answerTokenBudget, modelMaxTokens, "medium").maxTokens;
  }
  return {
    ...streamParams,
    maxTokens: Math.min(maxTokens, modelMaxTokens, streamParams?.maxTokens ?? maxTokens),
  };
}

export async function runCliIsolatedCompletion(
  request: RunIsolatedCompletionParams & {
    config: OpenClawConfig;
    agentId: string;
    agentDir: string;
    workspaceDir: string;
  },
  provider: string,
  modelProvider: string,
): Promise<IsolatedCompletionResult> {
  return await withTempWorkspace(
    { rootDir: resolvePreferredOpenClawTmpDir(), prefix: "openclaw-isolated-completion-" },
    async ({ dir }) => {
      const { runCliAgent } = await import("./cli-runner.runtime.js");
      request.assertCurrent?.();
      const { cliBackendAcceptsAuthProfileForwarding, resolveCliExecutionAuthProfileId } =
        await import("./cli-execution-auth.js");
      request.assertCurrent?.();
      // Fresh completions use the same account order as new CLI sessions.
      const authProfileId = cliBackendAcceptsAuthProfileForwarding({
        provider,
        config: request.config,
        agentId: request.agentId,
      })
        ? await resolveCliExecutionAuthProfileId({
            cliExecutionProvider: provider,
            authProfileProvider: modelProvider,
            config: request.config,
            agentDir: request.agentDir,
            selected: { authProfileId: request.authProfileId },
          })
        : request.authProfileId;
      request.assertCurrent?.();
      const sessionId = `isolated-completion-${randomUUID()}`;
      const config = request.config;
      const preparedRunAdmission = prepareSystemAgentRunAdmission(
        config,
        sessionId,
        request.agentId,
        "isolated-completion",
        request.assertCurrent,
        request.operatorAuthority,
      );
      try {
        request.assertCurrent?.();
        const result = await runCliAgent({
          preparedRunAdmission,
          sessionId,
          sessionFile: path.join(dir, "session.json"),
          workspaceDir: request.workspaceDir,
          cwd: dir,
          agentDir: request.agentDir,
          agentId: request.agentId,
          config,
          prompt: request.prompt,
          extraSystemPrompt: request.systemPrompt,
          timeoutMs: request.timeoutMs,
          runId: sessionId,
          provider,
          modelProvider,
          requesterModel: { provider: modelProvider, model: request.model },
          model: request.model,
          authProfileId,
          thinkLevel: request.thinkLevel,
          streamParams: resolveIsolatedStreamParams(request),
          abortSignal: request.abortSignal,
          assertCurrent: request.assertCurrent,
          mapOperatorAuthorizationError: request.mapOperatorAuthorizationError,
          executionMode: "side-question",
          cliToolAvailability: { native: [], openClaw: [] },
          disableTools: true,
          disableCliLiveSession: true,
          cleanupCliLiveSessionOnRunEnd: true,
          cleanupBundleMcpOnRunEnd: true,
          requireExplicitMessageTarget: true,
          isolatedCompletion: true,
          isolatedCompletionPurpose: request.purpose ?? "isolated-completion",
          outputTextPolicy: request.outputTextPolicy,
        });
        if (hasCliSideEffectEvidence(result)) {
          throw new IsolatedCompletionError(
            "output-rejected",
            "Isolated CLI completion returned side-effect evidence; result rejected.",
          );
        }
        const payloads = result.payloads ?? [];
        if (
          payloads.some(
            (payload) =>
              payload.isError ||
              payload.mediaUrl ||
              payload.mediaUrls?.length ||
              payload.audioAsVoice ||
              payload.channelData,
          )
        ) {
          throw new IsolatedCompletionError(
            "output-rejected",
            "Isolated CLI completion returned non-text output; result rejected.",
          );
        }
        const text = payloads
          .filter((payload) => !payload.isReasoning && typeof payload.text === "string")
          .map((payload) => payload.text ?? "")
          .join("\n")
          .trim();
        const backend = resolveCliBackendConfig(provider, request.config, {
          agentId: request.agentId,
        });
        if (!backend) {
          throw new IsolatedCompletionError(
            "runtime-unavailable",
            `CLI backend ${provider} became unavailable after execution.`,
          );
        }
        const { usage, diagnosticUsage } = result.meta?.agentMeta ?? {};
        return {
          text,
          provider: modelProvider,
          model: normalizeCliModel(request.model, backend.config),
          owner: { kind: "cli", id: provider },
          ...(usage ? { usage } : {}),
          ...(diagnosticUsage ? { diagnosticUsage } : {}),
        };
      } finally {
        preparedRunAdmission.close();
      }
    },
  );
}
