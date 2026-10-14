import type {
  CodexAppServerBindingStore,
  CodexAppServerBindingIdentity,
  CodexAppServerThreadBinding,
  CodexBindingAuthority,
} from "./session-binding.js";

/** Attempt cleanup may only clear the physical owner captured before its awaited work. */
export async function clearCodexBindingForClient(
  store: CodexAppServerBindingStore,
  identity: CodexAppServerBindingIdentity,
  thread: Pick<CodexAppServerThreadBinding, "threadId" | "clientId">,
  authority: CodexBindingAuthority,
): Promise<boolean> {
  if (!thread.clientId) {
    return false;
  }
  return await store.mutate(
    identity,
    { kind: "clear", threadId: thread.threadId, clientId: thread.clientId },
    authority.assertCurrent,
    authority,
  );
}
