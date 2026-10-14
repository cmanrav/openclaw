import { listAgentIds } from "../agents/agent-scope-config.js";
import { isIncognitoSessionKey } from "../routing/session-key.js";
import type { createSessionMembershipProjection } from "./session-membership-projection.js";
import type { createSessionRowPlacementProjection } from "./session-row-placement-projection.js";
import type * as rowRelations from "./session-row-projection-ancestors.js";
import type { createSessionRowProjectionBackfill } from "./session-row-projection-backfill.js";
import type { createSessionRowProjectionCatalog } from "./session-row-projection-catalog.js";
import type { createSessionRowProjectionContext } from "./session-row-projection-context.js";
import * as rowReads from "./session-row-projection-materialize.js";
import * as records from "./session-row-projection-record.js";
import type { createSessionRowProjectionRevisions } from "./session-row-projection-revisions.js";

export function createSessionRowMaterializer(params: {
  config: () => records.ProjectionOptions["cfg"];
  catalog: ReturnType<typeof createSessionRowProjectionCatalog>;
  metadata: ReturnType<typeof createSessionRowProjectionContext>;
  membership: ReturnType<typeof createSessionMembershipProjection>;
  placementFacts: ReturnType<typeof createSessionRowPlacementProjection>;
  backfill: ReturnType<typeof createSessionRowProjectionBackfill>;
  revisions: ReturnType<typeof createSessionRowProjectionRevisions>;
  readChildLinks: ReturnType<typeof rowRelations.createSessionRowRelationReads>["readChildLinks"];
  readSourceEntry: ReturnType<typeof rowRelations.createSessionRowRelationReads>["readSourceEntry"];
  gatewayContext: records.ProjectionOptions["context"];
  nextSequence: () => number;
}) {
  const {
    catalog,
    metadata,
    membership,
    placementFacts,
    backfill,
    revisions,
    readChildLinks,
    readSourceEntry,
  } = params;
  function materialize(
    row: records.Row,
    configuredAgentIds = new Set(listAgentIds(params.config())),
    readRow = rowReads.readResidentSessionRow,
    preparedDatabaseFacts?: records.PreparedSessionRowDatabaseFacts,
    repositoryWorkspace?: records.Inputs["preparedRepositoryWorkspace"],
  ) {
    const cfg = params.config();
    const retained = row.retainedDatabaseFacts;
    const databaseFacts =
      preparedDatabaseFacts ??
      (records.isPreparedSessionRowDatabaseFacts(retained) ? retained : undefined);
    if (!row.entry || (!databaseFacts && !isIncognitoSessionKey(row.key))) {
      return false;
    }
    const links = readChildLinks(row, databaseFacts !== undefined);
    if (!isIncognitoSessionKey(row.key)) {
      row.membership = new Set(membership.membership(row.storeTarget.storePath, row.key) ?? []);
    }
    const prepared = readRow({
      row: { ...row, entry: row.entry },
      cfg,
      modelCatalog: catalog.current,
      configuredAgentIds,
      context: metadata.current,
      subagentInputs: metadata.subagentInputs,
      gatewayContext: params.gatewayContext,
      placementFactsReader: placementFacts,
      links,
      readSourceEntry: (key) => readSourceEntry(row, key, databaseFacts !== undefined),
      databaseFacts,
      repositoryWorkspace,
    });
    if (!isIncognitoSessionKey(row.key)) {
      placementFacts.register(row.entry.sessionId);
    }
    const previousBoard = row.hasBoard;
    Object.assign(row, prepared, {
      materializedSequence: params.nextSequence(),
      ...metadata.materializedRevisions,
    });
    if (!isIncognitoSessionKey(row.key) && records.ready(row)) {
      backfill.prepare(row, databaseFacts);
    }
    revisions.materialized(row, previousBoard);
    return true;
  }
  return materialize;
}
