import {
  ErrorCodes,
  errorShape,
  validateChatAbortParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { resolveStateContentionPresentation } from "../../sessions/session-run-error-presentation.js";
import { formatStopRequest } from "../control-plane-audit.js";
import { handleChatAbortRequestWithLifecycle } from "./chat-abort-handler.lifecycle.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

export { handleChatAbortRequestWithLifecycle } from "./chat-abort-handler.lifecycle.js";
export async function handleChatAbortRequest(options: GatewayRequestHandlerOptions): Promise<void> {
  if (validateChatAbortParams(options.params)) {
    options.context.logGateway.info(
      formatStopRequest("chat.abort", options.client, options.params),
    );
  }
  try {
    await handleChatAbortRequestWithLifecycle(options);
  } catch (error) {
    const contention = resolveStateContentionPresentation(error);
    if (!contention) {
      throw error;
    }
    // A session read can fail even though cancellation takes effect. Do not
    // replay Stop or claim it had no effect; preserve uncertainty at the RPC boundary.
    options.respond(
      false,
      undefined,
      errorShape(
        ErrorCodes.UNAVAILABLE,
        "The server is busy. Check this turn's status before trying Stop again.\n\n" +
          "SQLite transaction admission remained busy. Stopping may already have taken effect.",
        { details: { errorKind: contention.errorKind } },
      ),
    );
  }
}
