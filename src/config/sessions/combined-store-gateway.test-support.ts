import {
  createSessionRowProjection,
  type SessionRowProjection,
} from "../../gateway/session-row-projection.js";
import type { OpenClawConfig } from "../types.openclaw.js";

export async function withResidentRows(
  cfg: OpenClawConfig,
  run: (projection: SessionRowProjection) => Promise<void>,
) {
  const projection = await createSessionRowProjection({ cfg });
  try {
    await run(projection);
  } finally {
    projection.dispose();
  }
}
