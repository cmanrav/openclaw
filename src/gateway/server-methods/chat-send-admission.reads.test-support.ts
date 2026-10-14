import { expect } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { setGatewayPluginMetadataSnapshot } from "../../plugins/current-plugin-metadata-snapshot.js";
import { retainGatewayPluginMetadata } from "../../plugins/plugin-metadata-lifecycle.js";
import { resolvePluginMetadataSnapshotAsync } from "../../plugins/plugin-metadata-snapshot.js";
import { prepareUserProfileCatalog } from "../../state/user-profile-list.js";
import { createTestGatewayScheduler } from "../../test-utils/gateway-scheduler-clock.js";

export async function withServingMetadata(cfg: OpenClawConfig, run: () => Promise<void>) {
  const scheduler = createTestGatewayScheduler();
  const metadataOwner = retainGatewayPluginMetadata(scheduler);
  let profiles: Awaited<ReturnType<typeof prepareUserProfileCatalog>> | undefined;
  try {
    // Gateway bootstrap publishes metadata; session projection retains profile facts.
    // Neither startup owner may admit the request's agent database.
    const metadata = await metadataOwner.runBootstrap(() =>
      resolvePluginMetadataSnapshotAsync({ config: cfg, allowCurrent: false }),
    );
    metadataOwner.publish(metadata);
    setGatewayPluginMetadataSnapshot(metadata, { config: cfg });
    profiles = await prepareUserProfileCatalog();
    await run();
  } finally {
    profiles?.release();
    await metadataOwner.beginClose();
    await scheduler.stop();
    expect((await metadataOwner.close()).failures).toEqual([]);
  }
}
