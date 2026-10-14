import type { SessionsFilesRevealResult } from "../../../../packages/gateway-protocol/src/index.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { GatewaySessionRow } from "../../api/types.ts";
import { parseAgentSessionKey } from "../../lib/sessions/session-key.ts";

export async function revealSessionWorkspace(
  client: GatewayBrowserClient,
  row: GatewaySessionRow,
  publishError: (error: unknown) => void,
): Promise<void> {
  const agentId = parseAgentSessionKey(row.key)?.agentId;
  try {
    const result = await client.request<SessionsFilesRevealResult>("sessions.files.reveal", {
      key: row.key,
      ...(agentId ? { agentId } : {}),
    });
    if (!result.ok) {
      const error = result.error ?? "Failed to reveal session workspace.";
      publishError(error);
    }
  } catch (error) {
    publishError(error);
  }
}
