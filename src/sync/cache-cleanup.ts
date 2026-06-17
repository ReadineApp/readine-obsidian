// START_MODULE_CONTRACT
// PURPOSE: Scan Readine/ for .md files older than limitCacheDays and delete them, subject to ArticleRegistry protection (favorited, hasNotes, local-edits mtime-guard). Respects cleanupExcludeFavorites and cleanupExcludeWithNotes settings for additional exclusion control.
// SCOPE: src/sync/cache-cleanup.ts
// DEPENDS: M-VAULT-FILE-STORAGE, M-SETTINGS-MANAGER, M-ARTICLE-REGISTRY, M-FRONTMATTER-CODEC
// LINKS: UC-011, V-M-CACHE-CLEANUP
// ROLE: RUNTIME
// MAP_MODE: EXPORTS
// END_MODULE_CONTRACT

// START_MODULE_MAP
// CacheScanResult - { deleted, scanned, protected } returned by scan()
// CacheCleanupDeps - DI bag: { storage, settings, registry, now? }
// CacheCleanup - class with scan(): Promise<CacheScanResult>
// END_MODULE_MAP

import type { IFileStorage } from "../storage/vault-file-storage";
import type { SettingsManager } from "../settings/settings-manager";
import type { ArticleRegistry } from "./article-registry";
import { removeAttachments } from "./base64-extractor";
import { getVaultRoot } from "../constants";

// START_BLOCK_TYPES

export interface CacheScanResult {
  deleted: number;
  scanned: number;
  protected: number;
}

export interface CacheCleanupDeps {
  storage: IFileStorage;
  settings: SettingsManager;
  registry: ArticleRegistry;
  now?: () => number;
}
// END_BLOCK_TYPES

// START_BLOCK_INTERNAL_LOG
const MODULE_ID = "M-CACHE-CLEANUP";

function logInfo(
  anchor: string,
  event: string,
  belief: string,
  requirement: string,
  details: Record<string, unknown> = {},
): void {
  console.debug({
    ts: new Date().toISOString(),
    level: "info",
    anchor,
    module: MODULE_ID,
    requirement,
    event,
    belief,
    ...details,
  });
}

function logWarn(
  anchor: string,
  event: string,
  belief: string,
  requirement: string,
  details: Record<string, unknown> = {},
): void {
  console.warn({
    ts: new Date().toISOString(),
    level: "warn",
    anchor,
    module: MODULE_ID,
    requirement,
    event,
    belief,
    ...details,
  });
}
// END_BLOCK_INTERNAL_LOG

// START_CONTRACT: CacheCleanup
// PURPOSE: Periodic cleanup of stale .md files in Readine/ based on limitCacheDays setting
// INPUTS: deps: CacheCleanupDeps (storage, settings, registry, now?)
// OUTPUTS: class with scan(): Promise<CacheScanResult>
// SIDE_EFFECTS: removes vault files via storage; emits CACHE_CLEANUP_SKIPPED / CACHE_CLEANUP_RESULT / CACHE_CLEANUP_PROTECTED / CACHE_CLEANUP_REMOVED / CACHE_CLEANUP_FAIL logs
// LINKS: UC-011, V-M-CACHE-CLEANUP
// END_CONTRACT: CacheCleanup
export class CacheCleanup {
  private readonly storage: IFileStorage;
  private readonly settings: SettingsManager;
  private readonly registry: ArticleRegistry;
  private readonly now: () => number;

  constructor(deps: CacheCleanupDeps) {
    this.storage = deps.storage;
    this.settings = deps.settings;
    this.registry = deps.registry;
    this.now = deps.now ?? (() => Date.now());
  }

  // START_CONTRACT: scan
  // PURPOSE: Walk Readine/, collect .md files, and delete those older than limitCacheDays after protection checks
  // INPUTS: none (state from deps)
  // OUTPUTS: Promise<CacheScanResult> — { deleted, scanned, protected }
  // SIDE_EFFECTS: vault file removal; structured logging per file
  // LINKS: UC-011, V-M-CACHE-CLEANUP
  // END_CONTRACT: scan
  async scan(): Promise<CacheScanResult> {
    // START_BLOCK_GUARDS
    const settings = this.settings.getAll();
    const rootPath = getVaultRoot(settings.pathTemplate) + "/";
    if (settings.limitCacheDays === "off") {
      logInfo(
        "scan:BLOCK_GUARDS",
        "CACHE_CLEANUP_SKIPPED",
        "limitCacheDays is off — cache cleanup disabled",
        "UC-011",
        { rootPath: rootPath },
      );
      return { deleted: 0, scanned: 0, protected: 0 };
    }

    const limitMs = settings.limitCacheDays * 24 * 60 * 60 * 1000;
    const cutoff = this.now() - limitMs;

    const excludeFavorites = settings.cleanupExcludeFavorites;
    const excludeWithNotes = settings.cleanupExcludeWithNotes;
    // END_BLOCK_GUARDS

    // START_BLOCK_COLLECT
    const mdFiles = await this.collectMdFiles(rootPath);
    const scanned = mdFiles.length;

    // If nothing to scan, return immediately to avoid logging an empty scan loop.
    if (scanned === 0) {
      logInfo(
        "scan:BLOCK_COLLECT",
        "CACHE_CLEANUP_RESULT",
        "no .md files found in Readine/",
        "UC-011",
        { rootPath: rootPath, cutoff },
      );
      return { deleted: 0, scanned: 0, protected: 0 };
    }

    logInfo(
      "scan:BLOCK_COLLECT",
      "CACHE_CLEANUP_RESULT",
      "scanning .md files for cache cleanup",
      "UC-011",
      { rootPath: rootPath, cutoff, totalFiles: scanned, excludeFavorites, excludeWithNotes },
    );
    // END_BLOCK_COLLECT

    // START_BLOCK_SCAN
    let deleted = 0;
    let protectedCount = 0;

    for (const filePath of mdFiles) {
      // Start with a fresh stat — file may have been removed between listing and processing.
      const stat = await this.storage.stat(filePath);
      if (!stat) {
        // File vanished between list and stat — treat as neither scanned nor protected
        // (the scan count still reflects our initial list, not a moving target).
        logWarn(
          "scan:BLOCK_SCAN",
          "CACHE_CLEANUP_SKIPPED",
          "file disappeared before stat — skipping",
          "UC-011",
          { filePath },
        );
        continue;
      }

      // Only consider files old enough — files newer than cutoff keep their place naturally.
      if (stat.mtime >= cutoff) {
        continue;
      }

      // Find entry in registry by filePath (fast path).
      let entry = this.registry.findByFilePath(filePath);

      // Settings-based exclusion: don't delete favorited articles.
      if (entry && excludeFavorites && entry.haveStar) {
        protectedCount += 1;
        logInfo(
          "scan:BLOCK_SCAN",
          "CACHE_CLEANUP_PROTECTED",
          "favorited article excluded by user setting",
          "UC-011",
          { filePath, articleId: entry.articleId, reason: "exclude_favorites" },
        );
        continue;
      }

      // Settings-based exclusion: don't delete articles with notes.
      if (entry && excludeWithNotes && entry.hasNotes) {
        protectedCount += 1;
        logInfo(
          "scan:BLOCK_SCAN",
          "CACHE_CLEANUP_PROTECTED",
          "article with notes excluded by user setting",
          "UC-011",
          { filePath, articleId: entry.articleId, reason: "exclude_with_notes" },
        );
        continue;
      }

      // Mtime-guard: don't delete if the user edited the file since last sync.
      const protection = this.registry.isProtectedByPath(filePath, stat.mtime);
      if (protection.protected) {
        protectedCount += 1;
        logInfo(
          "scan:BLOCK_SCAN",
          "CACHE_CLEANUP_PROTECTED",
          "article has local edits — skipping",
          "UC-011",
          { filePath, reason: "local_edits" },
        );
        continue;
      }

      // Clean up extracted _attachments via registry.
      if (entry?._attachments?.length) {
        await removeAttachments(entry._attachments, this.storage);
      }

      // All checks passed — delete the stale cache file.
      try {
        await this.storage.remove(filePath);
        deleted += 1;
        logInfo(
          "scan:BLOCK_SCAN",
          "CACHE_CLEANUP_REMOVED",
          "stale cache file deleted",
          "UC-011",
          { filePath },
        );
      } catch (err) {
        // Delete threw — file may still exist on disk. Count as protected (survived).
        protectedCount += 1;
        logWarn(
          "scan:BLOCK_SCAN",
          "CACHE_CLEANUP_FAIL",
          "remove threw — file may still exist",
          "UC-011",
          { filePath, error: err instanceof Error ? err.message : String(err) },
        );
      }
    }
    // END_BLOCK_SCAN

    logInfo(
      "scan:BLOCK_SCAN",
      "CACHE_CLEANUP_RESULT",
      "cache cleanup scan complete",
      "UC-011",
      { deleted, scanned, protected: protectedCount },
    );

    return { deleted, scanned, protected: protectedCount };
  }

  // START_BLOCK_RECURSE
  /**
   * Recursively walk directories under `dir` and collect all .md and .html file paths.
   * Obsidian DataAdapter.list() returns relative names — we build full paths by
   * prepending `dir/` at each recursion level.
   */
  private async collectMdFiles(dir: string): Promise<string[]> {
    const entries = await this.storage.list(dir);
    const files: string[] = [];

    for (const entry of entries) {
      const fullPath = `${dir}/${entry}`.replace(/\/{2,}/g, "/");
      if (entry.endsWith(".md") || entry.endsWith(".html")) {
        files.push(fullPath);
      } else {
        try {
          const subFiles = await this.collectMdFiles(fullPath);
          files.push(...subFiles);
        } catch {
          // Not a directory — skip silently.
        }
      }
    }

    return files;
  }
  // END_BLOCK_RECURSE
}

// START_CHANGE_SUMMARY
// LAST_CHANGE: 2026-05-31 — delete _attachments files before removing article file in cache cleanup
// END_CHANGE_SUMMARY
