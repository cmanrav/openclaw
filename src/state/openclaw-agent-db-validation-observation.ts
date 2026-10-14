import path from "node:path";
import { observeOwnedDirectory } from "../infra/owned-directory-observation.js";
import { assertExistingDatabaseIdentity } from "../infra/sqlite-worker-identity.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import type { OpenClawAgentDatabaseValidation } from "./openclaw-agent-db-validation-facts.js";

const validationObservations = resolveGlobalSingleton<
  Map<string, { close(): void; revalidate(): void }>
>(Symbol.for("openclaw.agentDatabaseValidationObservations"), () => new Map());

export function releaseValidationObservation(pathname: string): void {
  validationObservations.get(pathname)?.close();
}

export function observeValidationPath(
  pathname: string,
  admission: boolean,
  readValidation: () => OpenClawAgentDatabaseValidation | undefined,
  invalidate: (pathname: string, identity: string) => void,
): void {
  const existing = validationObservations.get(pathname);
  if (existing) {
    if (admission) {
      existing.revalidate();
    }
    return;
  }
  const revalidate = () => {
    const validation = readValidation();
    if (!validation || Atomics.load(new Int32Array(validation.valid), 0) !== 1) {
      return;
    }
    try {
      assertExistingDatabaseIdentity(pathname, `file:${validation.identity}`, validation.birthtime);
    } catch {
      invalidate(pathname, validation.identity);
    }
  };
  const watched = observeOwnedDirectory(
    path.dirname(pathname),
    (filename) => {
      if (
        filename === undefined ||
        (process.platform === "win32"
          ? filename.toLowerCase() === path.basename(pathname).toLowerCase()
          : filename === path.basename(pathname))
      ) {
        revalidate();
      }
    },
    { recoveryIntervalMs: 30_000 },
  );
  // Retained proof outlives native handles; its cache owns observation cleanup.
  validationObservations.set(pathname, {
    revalidate,
    close() {
      watched.close();
      validationObservations.delete(pathname);
    },
  });
  // The first subscriber must not retain a file replaced before observation began.
  revalidate();
}
