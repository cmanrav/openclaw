import { gatewayCredentialScope } from "@openclaw/gateway-client/browser";
import { i18n, isSupportedLocale } from "../i18n/index.ts";
import type { ApplicationConfigCapability } from "./config.ts";
import type { ApplicationGateway } from "./gateway.ts";
import {
  rememberProfileAppearanceIdentity,
  seedProfileAppearancePrefs,
} from "./server-prefs-profile.ts";
import { applyServerUiPrefs } from "./server-prefs-reconcile.ts";
import { extractProfileUiPrefs, PROFILE_UI_PREFERENCE_KEYS } from "./server-prefs-state.ts";
import type { UiSettings } from "./settings.ts";
import { seedUserPreferences } from "./user-prefs-cache.ts";

export function initializeDocumentPreferences(
  gateway: ApplicationGateway,
  config: ApplicationConfigCapability,
  settings: UiSettings,
  documentGatewayScope: string,
) {
  const canUseDocumentPreferences = () =>
    gatewayCredentialScope(gateway.connection.gatewayUrl) === documentGatewayScope;
  const documentPreferences = canUseDocumentPreferences() ? config.preferences : undefined;
  if (documentPreferences) {
    const scope = gateway.connection.gatewayUrl;
    const { profileId, entries } = documentPreferences;
    rememberProfileAppearanceIdentity(scope, profileId ?? null);
    if (profileId && entries) {
      seedProfileAppearancePrefs(scope, profileId, extractProfileUiPrefs(entries));
    }
    applyServerUiPrefs(documentPreferences.config ?? {}, {
      scope,
      profileId,
      navigationConfirmed: entries !== undefined,
      onApplied: (patch) => Object.assign(settings, patch),
    });
    if (isSupportedLocale(settings.locale)) {
      void i18n.setLocale(settings.locale);
    }
  }
  let firstPreferencesConnection = true;
  const stopBootstrapPreferences = gateway.subscribe((snapshot) => {
    if (snapshot.phase !== "connected" || !snapshot.client || !firstPreferencesConnection) {
      return;
    }
    firstPreferencesConnection = false;
    const { profileId, entries } = documentPreferences ?? {};
    if (
      canUseDocumentPreferences() &&
      profileId === snapshot.selfUser?.id &&
      profileId &&
      entries
    ) {
      seedUserPreferences(snapshot.client, profileId, PROFILE_UI_PREFERENCE_KEYS, entries);
    }
  });
  const getDocumentRuntimeConfig = () => {
    const preferences = config.preferences;
    return canUseDocumentPreferences() &&
      (gateway.snapshot.phase !== "connected" ||
        preferences?.profileId === gateway.snapshot.selfUser?.id)
      ? (preferences?.config ?? null)
      : null;
  };
  return { getDocumentRuntimeConfig, stopBootstrapPreferences };
}
