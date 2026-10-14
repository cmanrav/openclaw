import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { SessionPendingInputAuthorityFacts } from "../config/sessions/session-pending-input-authority.js";
import {
  acceptSessionSourceValidation,
  type PreparedSessionSourceAuthority,
  type SessionSourceValidation,
} from "../config/sessions/session-source-authority.js";
import type { InternalSessionEntry } from "../config/sessions/types.js";
import { createSqliteWorkerOperationAdmission } from "../infra/sqlite-worker-operation-admission.js";
import type { OpenClawAgentDatabase } from "../state/openclaw-agent-db-contract.js";
import type {
  AgentDatabaseRequestExecutionSource,
  OpenClawAgentDatabaseAdmissionExecution,
} from "../state/openclaw-agent-execution-admission-contract.js";
import { captureOpenClawAgentDatabaseExecution } from "../state/openclaw-agent-execution.js";
import { runOpenClawAgentWorkerWrite } from "../state/openclaw-agent-write-admission.js";
import { assertClientVoiceSessionSettlementCurrent } from "./client-voice-session-lifecycle.js";
import {
  captureClientVoiceSessionSource,
  createClientVoiceSessionSource,
  type ClientVoiceSessionSource,
} from "./client-voice-session-source.js";
import type { ClientVoiceSessionRecord } from "./client-voice-session-store.js";
import type { VoiceSessionMutation } from "./client-voice-session-write.kernel.js";

/** Voice metadata keeps its durable agent owner, including for incognito transcripts. */
export function captureClientVoiceSessionWriter(params: {
  agentId: string;
  assertCurrent?: () => void;
  physicalSource?: ClientVoiceSessionSource;
}) {
  const captured = params.physicalSource ?? captureClientVoiceSessionSource(params.agentId);
  const options = captured.options;
  captured.assertCurrent();
  const existing = captured.identity.key.startsWith("file:");
  const execution = captureOpenClawAgentDatabaseExecution(
    options,
    existing
      ? {
          expectedIdentity: {
            kind: "file",
            physicalIdentity: captured.identity.key.slice("file:".length),
            birthtime: captured.identity.birthtime,
            nativeLocation: captured.identity.canonicalPath,
          },
        }
      : { expectedCreationIdentity: captured.identity },
  );
  const assertCurrent = () => {
    assertClientVoiceSessionSettlementCurrent(captured.settlementContext);
    execution.assertCurrent();
    if (existing) {
      captured.assertCurrent();
    }
    params.assertCurrent?.();
  };
  const createSource = (
    authority?: PreparedSessionSourceAuthority,
  ): AgentDatabaseRequestExecutionSource => ({
    assertCurrent: () => {
      assertCurrent();
      authority?.assertCurrent();
    },
    createAdmission(binding) {
      return () => ({
        nativeLocations: binding.nativeLocations,
        admission: createSqliteWorkerOperationAdmission((request, grant) => {
          binding.authorize(request);
          const facts = isRecord(request.facts) ? request.facts.publication : undefined;
          if (isRecord(facts) && facts.kind === "voice-session-authority") {
            if (!authority) {
              throw new Error("Voice session authority omitted its prepared assertion");
            }
            if (facts.sourceValidation) {
              acceptSessionSourceValidation(
                authority,
                // SAFETY: voice.session.mutate supplies validation from this transaction.
                facts.sourceValidation as SessionSourceValidation,
              );
            }
            if (facts.facts) {
              if (!authority.transaction) {
                throw new Error("Voice session transaction omitted its prepared assertion");
              }
              // SAFETY: voice.session.mutate supplies the pending-input facts from this transaction.
              authority.transaction.assertCurrent(facts.facts as SessionPendingInputAuthorityFacts);
            }
            authority.assertCurrent();
          }
          if (!grant()) {
            throw new Error("Voice session write authority expired");
          }
        }, binding.attachment),
      });
    },
  });
  function mutate(
    input: VoiceSessionMutation,
    publish?: undefined,
    authority?: PreparedSessionSourceAuthority,
  ): Promise<ClientVoiceSessionRecord | undefined>;
  function mutate<T>(
    input: VoiceSessionMutation,
    publish: (record: ClientVoiceSessionRecord | undefined, entry?: InternalSessionEntry) => T,
    authority?: PreparedSessionSourceAuthority,
  ): Promise<T>;
  async function mutate<T>(
    input: VoiceSessionMutation,
    publish?: (record: ClientVoiceSessionRecord | undefined, entry?: InternalSessionEntry) => T,
    authority?: PreparedSessionSourceAuthority,
  ): Promise<T | ClientVoiceSessionRecord | undefined> {
    const mutation = structuredClone(input);
    const source = createSource(authority);
    return runOpenClawAgentWorkerWrite(options, async () => {
      if (mutation.kind === "create") {
        await execution.prepare(source);
      }
      const result = await execution.runExisting(source, async (worker) => {
        const committed = await worker.execute({
          type: "voice.session.mutate",
          input: {
            ...mutation,
            ...(authority?.transaction
              ? {
                  transactionSource: {
                    source: authority.transaction.source,
                    agentId: authority.transaction.agentId,
                    sessionKey: authority.transaction.sessionKey,
                  },
                }
              : {}),
            ...(authority?.checks.length
              ? { sources: authority.checks.map((check) => check.predicate) }
              : {}),
          },
        });
        // Install acknowledged facts before releasing the existing writer FIFO.
        return {
          value: publish ? publish(committed.record, committed.entry) : committed.record,
        };
      });
      if (!result) {
        throw new Error("Voice session database is missing");
      }
      return result.value;
    });
  }
  const readCommittedIdentity = () => {
    const committed = execution.fileIdentity;
    return (
      committed && {
        key: `file:${committed.physicalIdentity}`,
        birthtime: committed.birthtime,
        canonicalPath: committed.nativeLocation,
      }
    );
  };
  return {
    options,
    get identity() {
      return readCommittedIdentity() ?? captured.identity;
    },
    settlementContext: captured.settlementContext,
    get source(): ClientVoiceSessionSource {
      assertCurrent();
      const committed = readCommittedIdentity();
      if (committed) {
        return createClientVoiceSessionSource(options, committed);
      }
      if (existing) {
        return captured;
      }
      throw new Error("Voice session creation has not been acknowledged");
    },
    assertCurrent,
    get admissionExecution(): OpenClawAgentDatabaseAdmissionExecution {
      return execution;
    },
    adoptNativeDatabase: (database: OpenClawAgentDatabase) =>
      execution.adoptNativeDatabase(database),
    release: () => execution.release(),
    read(voiceSessionId: string) {
      return runOpenClawAgentWorkerWrite(options, () =>
        execution.runExisting(createSource(), async (worker) => {
          const result = await worker.execute({
            type: "voice.session.read",
            input: { voiceSessionId },
          });
          assertCurrent();
          return result;
        }),
      );
    },
    mutate,
  };
}

export type ClientVoiceSessionWriter = ReturnType<typeof captureClientVoiceSessionWriter>;
