// START_MODULE_CONTRACT
// PURPOSE: Single source of truth for plugin-wide constants: API endpoints, device signature, platform label builder. Changing a value here updates all consumers.
// SCOPE: src/constants.ts
// DEPENDS: M-PLATFORM
// LINKS: UC-001, UC-003, UC-018
// ROLE: CONFIG
// MAP_MODE: EXPORTS
// END_MODULE_CONTRACT

// START_MODULE_MAP
// ManifestLike - structural slice of Obsidian manifest for version/id extraction
// API_BASE_URL - Readine REST API base
// LOGS_BASE_URL - Readine Logs API base (anonymous error upload)
// API_VERSION - API version string sent in every request header
// DS - device signature, always "obsidian" for this plugin
// DsType - literal type of DS ("obsidian")
// getPlatformLabel - build platform label: "obsidian-desktop/x.y.z" or "obsidian-mobile/x.y.z"
// getClientVersion - extract plugin semver from Obsidian manifest
// getObsidianVersion - extract host app version from Obsidian App instance
// getDictCachePath - build vault path for zstd dictionary cache under .obsidian/{pluginId}/
// getRegistryPath - build vault path for article registry under .obsidian/{pluginId}/
// getNotificationsPath - build vault path for notifications persistence under .obsidian/{pluginId}/
// SYNC_CHUNK_SIZE - article delta chunk size
// SYNC_TIMEOUT_MS - per-chunk hard timeout
// SYNC_RETRIES - retry count per chunk
// SYNC_RETRY_DELAY_MS - base delay for exponential backoff (article sync)
// NOTIFICATIONS_SYNC_RETRIES - retry count for notifications sync
// NOTIFICATIONS_SYNC_RETRY_DELAY_MS - base delay for exponential backoff (notifications sync)
// PENDING_SAVE_INTERVAL - save pending.json every N processed articles during Phase C
// DEFAULT_FILE_TEMPLATE - default markdown template used by VaultWriter
// getVaultRoot - extract root folder from pathTemplate
// END_MODULE_MAP

import { apiVersion } from "obsidian";
import { isMobile } from "./platform/platform";

// START_BLOCK_CONSTANTS
/** Manifest shape — the fields we read from Obsidian's PluginManifest. */
export type ManifestLike = { version?: string; id?: string } | undefined;

export const API_BASE_URL = "https://readine.app";
export const LOGS_BASE_URL = "https://logs.readine.app";
export const API_VERSION = "1.0";

/** Device signature — invariant for Obsidian plugin. */
export const DS = "obsidian" as const;
export type DsType = typeof DS;

/** Article delta chunk size. */
export const SYNC_CHUNK_SIZE = 50;
/** Per-chunk hard timeout in ms (5 minutes). */
export const SYNC_TIMEOUT_MS = 5 * 60 * 1000;
/** Retry count per chunk (article sync). */
export const SYNC_RETRIES = 3;
/** Base delay (ms) for exponential backoff — article sync. */
export const SYNC_RETRY_DELAY_MS = 1000;

/** Retry count for notifications sync. */
export const NOTIFICATIONS_SYNC_RETRIES = 3;
/** Base delay (ms) for exponential backoff — notifications sync. */
export const NOTIFICATIONS_SYNC_RETRY_DELAY_MS = 1000;

/** Save pending.json every N processed articles during Phase C download/write. */
export const PENDING_SAVE_INTERVAL = 100;

/** Default file template for markdown format. User-configurable via `fileTemplate`. */
export const DEFAULT_FILE_TEMPLATE = `---
title: "{{title}}"
date: {{date}}
url: {{url}}
tags: {{tags}}
feed: "{{feedName}}"
notes: "{{notes}}"
articleId: {{id}}
---

{{text}}`;

/** Default file template for html format. */
// END_BLOCK_CONSTANTS

// START_CONTRACT: getPlatformLabel
// PURPOSE: build the platform label sent in LoginByObsidianCode payload
// INPUTS: obsidianVersion: string — host app version, e.g. "1.7.4"
// OUTPUTS: string — "obsdsktp" or "obsmob"
// SIDE_EFFECTS: calls isMobile() from M-PLATFORM (logs a debug marker)
// LINKS: UC-001
// END_CONTRACT: getPlatformLabel
export function getPlatformLabel(obsidianVersion: string): string {
  return `${isMobile() ? "obsmob" : "obsdsktp"}`;
}

// START_CONTRACT: getClientVersion
// PURPOSE: extract plugin semver from Obsidian's PluginManifest
// INPUTS: manifest: ManifestLike — usually this.manifest from Plugin
// OUTPUTS: string — semver string e.g. "1.2.3" or "0.0.0" as fallback
// SIDE_EFFECTS: none (pure function)
// LINKS: UC-001, UC-019
// END_CONTRACT: getClientVersion
export function getClientVersion(manifest: ManifestLike): string {
  return typeof manifest?.version === "string" ? manifest.version : "0.0.0";
}

// START_CONTRACT: getObsidianVersion
// PURPOSE: return the Obsidian API version at module load time, or 'unknown' if not available
// INPUTS: none
// OUTPUTS: string — e.g. "0.13.21" or "unknown"
// SIDE_EFFECTS: none
// LINKS: UC-019
// END_CONTRACT: getObsidianVersion
export function getObsidianVersion(): string {
  return apiVersion ?? "unknown";
}

// START_CONTRACT: getDictCachePath
// PURPOSE: build the vault path for zstd dictionary cache under .obsidian/plugins/{pluginId}/
// INPUTS: manifest: ManifestLike — usually this.manifest from Plugin
// OUTPUTS: string — e.g. ".obsidian/plugins/readine-sync/cache/dictionaries"
// SIDE_EFFECTS: none (pure)
// LINKS: UC-003
// END_CONTRACT: getDictCachePath
export function getDictCachePath(manifest: ManifestLike): string {
  const id = typeof manifest?.id === "string" ? manifest.id : "readine-sync";
  return `.obsidian/plugins/${id}/cache/dictionaries`;
}

// START_CONTRACT: getRegistryPath
// PURPOSE: build vault path for ArticleRegistry persistence file
// INPUTS: manifest: ManifestLike
// OUTPUTS: string — e.g. ".obsidian/plugins/readine-sync/registry.json"
// SIDE_EFFECTS: none (pure)
// LINKS: UC-016
// END_CONTRACT: getRegistryPath
export function getRegistryPath(manifest: ManifestLike): string {
  const id = typeof manifest?.id === "string" ? manifest.id : "readine-sync";
  return `.obsidian/plugins/${id}/registry.json`;
}

// START_CONTRACT: getNotificationsPath
// PURPOSE: build vault path for NotificationsStore persistence file
// INPUTS: manifest: ManifestLike
// OUTPUTS: string — e.g. ".obsidian/plugins/readine-sync/notifications.json"
// SIDE_EFFECTS: none (pure)
// LINKS: UC-022
// END_CONTRACT: getNotificationsPath
export function getNotificationsPath(manifest: ManifestLike): string {
  const id = typeof manifest?.id === "string" ? manifest.id : "readine-sync";
  return `.obsidian/plugins/${id}/notifications.json`;
}

// START_CONTRACT: getVaultRoot
// PURPOSE: extract the root folder (first path segment) from a pathTemplate
// INPUTS: pathTemplate: string — e.g. "Readine/{feedName}/{title}.md"
// OUTPUTS: string — e.g. "Readine"
// SIDE_EFFECTS: none (pure)
// LINKS: UC-011
// END_CONTRACT: getVaultRoot
export function getVaultRoot(pathTemplate: string): string {
  return pathTemplate.split("/")[0] ?? "Readine";
}

// START_CHANGE_SUMMARY
// LAST_CHANGE: 2026-05-31 — extracted from main.ts: DS, getPlatformLabel, API URLs
// LAST_CHANGE: 2026-06-04 — fix getObsidianVersion: use apiVersion from obsidian instead of non-existent app.appVersion
// LAST_CHANGE: 2026-06-07 — add getNotificationsPath for file-backed notifications persistence
// LAST_CHANGE: 2026-06-07 — change all three paths (getDictCachePath, getRegistryPath, getNotificationsPath) from .obsidian/{id}/ to .obsidian/plugins/{id}/
// END_CHANGE_SUMMARY
