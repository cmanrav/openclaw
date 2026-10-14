import { setTimeout as waitForProcessTick } from "node:timers/promises";

// Native transport joins its root and signal dispatch, not foreign descendant extinction.
export async function waitForProcessExit(pids: number[], signal: AbortSignal): Promise<void> {
  try {
    for (;;) {
      if (
        pids.every((pid) => {
          try {
            process.kill(pid, 0);
            return false;
          } catch {
            return true;
          }
        })
      ) {
        return;
      }
      await waitForProcessTick(10, undefined, { signal });
    }
  } catch (cause) {
    throw new Error(`Claude process tree ${pids.join(", ")} did not exit before the test aborted`, {
      cause,
    });
  }
}
