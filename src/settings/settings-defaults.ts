// START_MODULE_CONTRACT
// PURPOSE: First-run defaults for the SettingsSnapshot. Returns a fresh object per call so callers can safely mutate or pass into SettingsManager constructor. The only platform-aware field is `networkForArticles` (mobile defaults to Wi-Fi-only to respect cellular data). All other defaults are static and mirror docs/development-plan.xml.
// SCOPE: src/settings/settings-defaults.ts
// DEPENDS: M-PLATFORM
// LINKS: UC-009, V-M-SETTINGS-DEFAULTS
// ROLE: RUNTIME
// END_MODULE_CONTRACT

// START_MODULE_MAP
// PlatformKind - 'mobile' | 'desktop' union accepted by getDefaults
// getDefaults - pure factory returning a SettingsSnapshot with platform-aware networkForArticles
// getDefaultsForCurrentPlatform - convenience wrapper that auto-detects via M-PLATFORM.isMobile()
// END_MODULE_MAP

import { isMobile } from "../platform/platform";
import { detectDefaultLanguage } from "../i18n/i18n";
import type { SettingsSnapshot } from "./settings-manager";
import { DEFAULT_FILE_TEMPLATE } from "../constants";

// START_BLOCK_TYPES
/** Platform discriminator accepted by getDefaults. */
export type PlatformKind = "mobile" | "desktop";
// END_BLOCK_TYPES

// START_CONTRACT: getDefaults
// PURPOSE: build a fresh SettingsSnapshot suited for first-run initialization
// INPUTS: platform: PlatformKind
// OUTPUTS: SettingsSnapshot — networkForArticles is the only platform-aware field
// SIDE_EFFECTS: none (pure function); returns a new object so caller can mutate freely
// LINKS: UC-009, V-M-SETTINGS-DEFAULTS
// END_CONTRACT: getDefaults
export function getDefaults(platform: PlatformKind): SettingsSnapshot {
  // START_BLOCK_DEFAULT_VALUES
  // Mobile defaults to Wi-Fi-only to respect cellular data — see docs/development-plan.xml
  // M-SETTINGS-DEFAULTS.contract.purpose. Desktop defaults to 'always' (no metered network concerns).
  const networkForArticles: SettingsSnapshot["networkForArticles"] =
    platform === "mobile" ? "Wi-Fi-only" : "always";

  return {
    sessionId: null,
    userId: null,
    outputFormat: "markdown",
    pathTemplate: "Readine/{feedName}/{yyyy}-{mm}/{title}.md",
    deletePolicy: "keep" as const,
    autoSyncInterval: 5,
    networkForArticles,
    limitCacheDays: "off",
    uiLanguage: detectDefaultLanguage(),
    lastSyncError: null,
    notificationsBadge: true,
    syncFavoritesOnly: true,
    cleanupExcludeFavorites: true,
    cleanupExcludeWithNotes: true,
    uiLanguageSet: false,
    wizardCompleted: false,
    fileTemplate: DEFAULT_FILE_TEMPLATE,

  };
  // END_BLOCK_DEFAULT_VALUES
}

// START_CONTRACT: getDefaultsForCurrentPlatform
// PURPOSE: convenience wrapper that picks mobile/desktop based on M-PLATFORM
// INPUTS: none
// OUTPUTS: SettingsSnapshot
// SIDE_EFFECTS: invokes isMobile() — which emits a PLATFORM_DETECTED log marker (UC-004)
// LINKS: UC-004, UC-009, V-M-SETTINGS-DEFAULTS
// END_CONTRACT: getDefaultsForCurrentPlatform
export function getDefaultsForCurrentPlatform(): SettingsSnapshot {
  return getDefaults(isMobile() ? "mobile" : "desktop");
}

// START_CHANGE_SUMMARY
// LAST_CHANGE: 2026-05-27 — add lastNotificationsSyncStamp + notificationsBadge defaults for M-NOTIFICATIONS
// LAST_CHANGE: 2026-06-04 — change autoSyncInterval default from 30→5
// LAST_CHANGE: 2026-06-07 — remove lastNotificationsSyncStamp default (moved to file-backed NotificationsStore)
// LAST_CHANGE: 2026-06-07 — remove pathMappings default (moved to ArticleRegistry)
// END_CHANGE_SUMMARY
