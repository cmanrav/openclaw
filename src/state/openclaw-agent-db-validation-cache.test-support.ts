import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import type {
  OpenClawAgentDatabase,
  OpenClawAgentDatabaseOptions,
} from "./openclaw-agent-db-contract.js";
import { invalidateOpenClawAgentDatabaseValidation } from "./openclaw-agent-db-validation-cache.js";
import {
  openOpenClawAgentDatabase,
  closeOpenClawAgentDatabaseByPath,
} from "./openclaw-agent-db.js";

export async function withReceiptFixture(
  populated: boolean,
  run: (
    database: OpenClawAgentDatabase,
    options: OpenClawAgentDatabaseOptions,
  ) => void | Promise<void>,
) {
  await withOpenClawTestState({ scenario: "minimal" }, async ({ env }) => {
    const options = { agentId: "main", env };
    let database = openOpenClawAgentDatabase(options);
    if (populated) {
      database.db.exec(`INSERT INTO session_nodes
        (session_key, current_session_id, entry_json, updated_at)
        VALUES ('agent:main:existing', 'existing', '{"sessionId":"existing","updatedAt":1}', 1);
        UPDATE session_nodes SET entry_valid = 1;
        DELETE FROM session_canonical_validation_pending;`);
      invalidateOpenClawAgentDatabaseValidation(database.path);
      closeOpenClawAgentDatabaseByPath(database.path);
      database = openOpenClawAgentDatabase(options);
    }
    await run(database, options);
  });
}
