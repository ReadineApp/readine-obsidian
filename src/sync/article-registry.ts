// START_MODULE_CONTRACT
// PURPOSE: In-memory article state registry. Maps feedItemId → ArticleEntry for protection checks. Persisted to a dedicated JSON file (not saveData) for scalability — supports 10k+ entries without bloating plugin settings. Holds lastSyncStamp for crash-recovery watermark resumption. Also manages pending.json for two-phase sync (load/dload tasks survive crashes).
// SCOPE: src/sync/article-registry.ts
// DEPENDS: M-VAULT-FILE-STORAGE
// LINKS: UC-003, UC-007, UC-016
// ROLE: RUNTIME
// MAP_MODE: EXPORTS
// END_MODULE_CONTRACT

// START_MODULE_MAP
// ArticleEntry - per-article metadata (feedItemId, articleId, filePath, haveStar, hasNotes, lastSyncWriteMtime, _attachments)
// ArticleRegistryInput - shape accepted by putEntry
// PendingArticleStatus - union 'written'|'skipped'|'cdn_failed'
// PendingArticle - pending article with per-article processing status (written/skipped/cdn_failed)
// PendingBatch - task batch from server delta
// PendingContainer - whole pending.json envelope
// ProtectionResult - { protected, reason? }
// ArticleRegistry - class with load/flush/putEntry/remove/get/isProtected + lastSyncStamp + cdnConfig + feeds + pending management + getTotalCount + getPathMappings + putPathMappings + removePathMapping
// END_MODULE_MAP

import type { IFileStorage } from "../storage/vault-file-storage";
import type { CdnStrategyLike } from "./cdn-resolver";
import type { FeedRecord } from "../api/clientV1_0";

// START_BLOCK_TYPES
export interface ArticleEntry {
  feedItemId: string;
  articleId: string;
  filePath: string;
  haveStar: boolean;
  hasNotes: boolean;
  lastSyncWriteMtime: number;
  _attachments: string[];
}

export interface ArticleRegistryInput {
  feedItemId: string;
  articleId: string;
  filePath: string;
  haveStar: boolean;
  hasNotes: boolean;
  lastSyncWriteMtime: number;
  _attachments?: string[];
}

export interface ProtectionResult {
  protected: boolean;
  reason?: string;
}

export type PendingArticleStatus = "written" | "skipped" | "cdn_failed";

export interface PendingArticle {
  feedItemId: string;
  articleId: string;
  url: string;
  title: string;
  feedId: string;
  feedName: string;
  date: string;
  tags: string[];
  notes: string[];
  haveStar: boolean;
  dictionaryId: string;
  filePath?: string;
  status?: PendingArticleStatus;
}

export interface PendingBatch {
  type: "byId" | "byPrefix";
  ids: string[];
  status: "pending" | "loaded";
  articles?: PendingArticle[];
  /** Whether this batch is part of a full-update sync cycle. */
  isFullUpdate?: boolean;
}

export interface PendingContainer {
  batches: PendingBatch[];
  newStamp: number;
  /** true when _processPending has been run on this container. */
  processed?: boolean;
  /** Whether the server signaled a full update for this sync cycle. */
  isFullUpdate?: boolean;
}

interface RegistryFile {
  lastSyncStamp: number;
  cdnConfig?: CdnStrategyLike | null;
  feeds?: FeedRecord[];
  entries: Record<string, ArticleEntry>;
  pathMappings: Record<string, string>;
}
// END_BLOCK_TYPES

// START_BLOCK_INTERNAL_LOG
const MODULE_ID = "M-ARTICLE-REGISTRY";

function logInfo(
  anchor: string,
  event: string,
  belief: string,
  details: Record<string, unknown> = {},
): void {
  // eslint-disable-next-line no-console
  console.debug({
    ts: new Date().toISOString(),
    level: "info",
    anchor,
    module: MODULE_ID,
    requirement: "UC-016",
    event,
    belief,
    ...details,
  });
}

function logWarn(
  anchor: string,
  event: string,
  belief: string,
  details: Record<string, unknown> = {},
): void {
  // eslint-disable-next-line no-console
  console.warn({
    ts: new Date().toISOString(),
    level: "warn",
    anchor,
    module: MODULE_ID,
    requirement: "UC-016",
    event,
    belief,
    ...details,
  });
}
// END_BLOCK_INTERNAL_LOG

// START_CONTRACT: ArticleRegistry
// PURPOSE: in-memory registry with file-backed persistence (IFileStorage, not saveData); watermark tracking; global CDN config; feed list
// INPUTS: deps: { storage: IFileStorage, registryPath: string }
// OUTPUTS: class with load / flush / putEntry / remove / get / getByArticleId / findByFilePath / isProtected / isProtectedByPath + lastSyncStamp + cdnConfig + feeds + saveFeedsDelta
// SIDE_EFFECTS: read/write registry.json via storage; emits REGISTRY_* structured logs
// LINKS: UC-007, UC-016
// END_CONTRACT: ArticleRegistry
export class ArticleRegistry {
  private readonly _entries: Map<string, ArticleEntry> = new Map();
  private readonly _byArticleId: Map<string, ArticleEntry> = new Map();
  private readonly _byFilePath: Map<string, ArticleEntry> = new Map();
  private readonly _storage: IFileStorage;
  private readonly _path: string;
  private _pathMappings: Record<string, string> = {};

  /*Path to additional JSON file with pending records*/
  private readonly _pendingPath: string;

  /** Watermark stamp for article sync delta — survives crash, allows resume. */
  lastSyncStamp = 0;

  /** Global CDN config, one for all articles. Updated when server sends non-null. */
  cdnConfig: CdnStrategyLike | null = null;

  /** Global feed list — feedId → FeedRecord. Updated from server delta. */
  feeds: FeedRecord[] = [];

  constructor(deps: { storage: IFileStorage; registryPath: string }) {
    this._storage = deps.storage;
    this._path = deps.registryPath;
    this._pendingPath = deps.registryPath.replace(/\.json$/, "-pending.json");
  }

  // START_BLOCK_LOAD
  async load(): Promise<void> {
    this._entries.clear();
    this._byArticleId.clear();
    this._byFilePath.clear();

    try {
      const exists = await this._storage.exists(this._path);
      if (!exists) {
        this.lastSyncStamp = 0;
        logInfo("load:BLOCK_LOAD", "REGISTRY_LOAD", "registry file not found — starting fresh", { path: this._path });
        return;
      }
      const raw = await this._storage.read(this._path);
      const data: RegistryFile = JSON.parse(raw);
      this.lastSyncStamp = typeof data.lastSyncStamp === "number" ? data.lastSyncStamp : 0;
      this.cdnConfig = data.cdnConfig ?? null;
      this.feeds = data.feeds ?? [];
      this._pathMappings = data.pathMappings ?? {};

      for (const [feedItemId, entry] of Object.entries(data.entries ?? {})) {
        this._entries.set(feedItemId, entry);
        this._byArticleId.set(entry.articleId, entry);
        this._byFilePath.set(entry.filePath, entry);
      }
      logInfo("load:BLOCK_LOAD", "REGISTRY_LOAD", "entries loaded from registry file", {
        count: this._entries.size,
        lastSyncStamp: this.lastSyncStamp,
      });
    } catch (err) {
      logWarn("load:BLOCK_LOAD", "REGISTRY_LOAD_FAILED", "could not load registry file — starting fresh", {
        error: err instanceof Error ? err.message : String(err),
      });
      this.lastSyncStamp = 0;
    }
  }
  // END_BLOCK_LOAD

  // START_BLOCK_FLUSH
  async flush(): Promise<void> {
    const data: RegistryFile = {
      lastSyncStamp: this.lastSyncStamp,
      cdnConfig: this.cdnConfig,
      feeds: this.feeds,
      entries: Object.fromEntries(this._entries),
      pathMappings: this._pathMappings,
    };
    try {
      await this._storage.write(this._path, JSON.stringify(data));
      logInfo("flush:BLOCK_FLUSH", "REGISTRY_FLUSH", "registry written to file", {
        count: this._entries.size,
        lastSyncStamp: this.lastSyncStamp,
      });
    } catch (err) {
      logWarn("flush:BLOCK_FLUSH", "REGISTRY_FLUSH_FAILED", "could not write registry file", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  // END_BLOCK_FLUSH

  // START_BLOCK_PENDING
  async loadPending(): Promise<PendingContainer | null> {
    try {
      const exists = await this._storage.exists(this._pendingPath);
      if (!exists) return null;
      const raw = await this._storage.read(this._pendingPath);
      return JSON.parse(raw) as PendingContainer;
    } catch (err) {
      logWarn("loadPending:BLOCK_PENDING", "PENDING_LOAD_FAILED", "could not load pending file", {
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  async savePending(data: PendingContainer): Promise<void> {
    try {
      await this._storage.write(this._pendingPath, JSON.stringify(data));
      logInfo("savePending:BLOCK_PENDING", "PENDING_SAVED", "pending file written", {
        batches: data.batches.length,
        newStamp: data.newStamp,
      });
    } catch (err) {
      logWarn("savePending:BLOCK_PENDING", "PENDING_SAVE_FAILED", "could not write pending file", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async clearPending(): Promise<void> {
    try {
      const exists = await this._storage.exists(this._pendingPath);
      if (exists) {
        await this._storage.remove(this._pendingPath);
        logInfo("clearPending:BLOCK_PENDING", "PENDING_CLEARED", "pending file removed", {});
      }
    } catch {
      // Already gone — fine.
    }
  }

  // START_CONTRACT: clear
  // PURPOSE: remove all entries from in-memory registry and persist empty file.
  //          Preserves pathMappings, lastSyncStamp, cdnConfig, feeds — those are
  //          needed for delete-policy (path lookups via feedItemId) and delta continuity.
  //          For full user-logout reset, use fullReset() instead.
  // SIDE_EFFECTS: writes empty entries to registry.json; emits REGISTRY_CLEARED log
  // LINKS: UC-003, UC-016
  // END_CONTRACT: clear
  async clear(): Promise<void> {
    this._entries.clear();
    this._byArticleId.clear();
    this._byFilePath.clear();
    await this.flush();
    logInfo("clear:BLOCK_CLEAR", "REGISTRY_CLEARED", "all entries removed on full update", {});
  }

  // START_CONTRACT: fullReset
  // PURPOSE: fully reset registry to initial state — clears entries, pathMappings,
  //          lastSyncStamp, cdnConfig, feeds, and pending file. Invoked on
  //          user-initiated logout (UC-002) to prevent stale data from leaking
  //          into the next login session.
  // SIDE_EFFECTS: writes empty registry.json; removes pending file; emits REGISTRY_FULL_RESET log
  // LINKS: UC-002
  // END_CONTRACT: fullReset
  async fullReset(): Promise<void> {
    this._entries.clear();
    this._byArticleId.clear();
    this._byFilePath.clear();
    this._pathMappings = {};
    this.lastSyncStamp = 0;
    this.cdnConfig = null;
    this.feeds = [];
    await this.flush();
    await this.clearPending();
    logInfo("fullReset:BLOCK_FULL_RESET", "REGISTRY_FULL_RESET", "full registry reset — entries + pathMappings + stamp + feeds + cdn + pending cleared for logout", {});
  }
  // END_BLOCK_PENDING

  // START_BLOCK_PATH_MAPPINGS
  getPathMappings(): Record<string, string> {
    return { ...this._pathMappings };
  }

  putPathMappings(delta: Record<string, string>): void {
    Object.assign(this._pathMappings, delta);
  }

  // START_CONTRACT: removePathMapping
  // PURPOSE: remove a single feedItemId→path mapping entry — called after
  //          successful delete-policy execution to prevent pathMappings from
  //          growing unboundedly and causing false occupation conflicts on
  //          future syncs (UC-016).
  // INPUTS: feedItemId: string
  // SIDE_EFFECTS: mutates _pathMappings in-place
  // LINKS: UC-016
  // END_CONTRACT: removePathMapping
  removePathMapping(feedItemId: string): void {
    delete this._pathMappings[feedItemId];
  }
  // END_BLOCK_PATH_MAPPINGS

  // START_BLOCK_FEEDS
  // START_CONTRACT: saveFeedsDelta
  // PURPOSE: apply server feed delta — full update clears everything, otherwise
  //          isDeleted feeds are removed, others upserted by feedId.
  // INPUTS: feeds — FeedRecord[] from fetchDelta, isFullUpdate — boolean
  // SIDE_EFFECTS: mutates this.feeds
  // LINKS: UC-003
  // END_CONTRACT: saveFeedsDelta
  saveFeedsDelta(feeds: FeedRecord[], isFullUpdate: boolean): void {
    if (isFullUpdate) {
      this.feeds = [];
    }

    const toDelete: string[] = [];
    for (const f of feeds) {
      if (!f.feedId) continue;
      if (f.isDeleted) {
        toDelete.push(f.feedId);
        continue;
      }
      const idx = this.feeds.findIndex((x) => x.feedId === f.feedId);
      if (idx >= 0) {
        this.feeds[idx] = f;
      } else {
        this.feeds.push(f);
      }
    }

    if (toDelete.length > 0) {
      this.feeds = this.feeds.filter((f) => f.feedId ? !toDelete.includes(f.feedId) : true);
    }

    logInfo("saveFeedsDelta:BLOCK_FEEDS", "FEEDS_SAVED", "feed delta applied", {
      addedOrUpdated: feeds.length - toDelete.length,
      deleted: toDelete.length,
      total: this.feeds.length,
    });
  }
  // END_BLOCK_FEEDS

  // START_BLOCK_PUT_ENTRY
  putEntry(input: ArticleRegistryInput): void {
    const entry: ArticleEntry = {
      feedItemId: input.feedItemId,
      articleId: input.articleId,
      filePath: input.filePath,
      haveStar: input.haveStar,
      hasNotes: input.hasNotes,
      lastSyncWriteMtime: input.lastSyncWriteMtime,
      _attachments: input._attachments ?? [],
    };

    const existing = this._entries.get(input.feedItemId);
    if (existing) {
      if (existing.filePath !== input.filePath) this._byFilePath.delete(existing.filePath);
      if (existing.articleId !== input.articleId) this._byArticleId.delete(existing.articleId);
    }

    this._entries.set(input.feedItemId, entry);
    this._byArticleId.set(input.articleId, entry);
    this._byFilePath.set(input.filePath, entry);

    logInfo("putEntry:BLOCK_UPSERT", "REGISTRY_PUT", existing ? "entry updated" : "entry added", {
      feedItemId: input.feedItemId,
      articleId: input.articleId,
      filePath: input.filePath,
      haveStar: input.haveStar,
      hasNotes: input.hasNotes,
    });
  }
  // END_BLOCK_PUT_ENTRY

  // START_BLOCK_REMOVE
  remove(feedItemId: string): void {
    const entry = this._entries.get(feedItemId);
    if (!entry) {
      logWarn("remove:BLOCK_REMOVE", "REGISTRY_REMOVE_MISSING", "tried to remove non-existent feedItemId", { feedItemId });
      return;
    }
    this._entries.delete(feedItemId);
    this._byArticleId.delete(entry.articleId);
    this._byFilePath.delete(entry.filePath);
    logInfo("remove:BLOCK_REMOVE", "REGISTRY_REMOVE", "entry removed", { feedItemId, articleId: entry.articleId });
  }
  // END_BLOCK_REMOVE

  // START_BLOCK_LOOKUPS
  get(feedItemId: string): ArticleEntry | null {
    return this._entries.get(feedItemId) ?? null;
  }
  getByArticleId(articleId: string): ArticleEntry | null {
    return this._byArticleId.get(articleId) ?? null;
  }
  findByFilePath(filePath: string): ArticleEntry | null {
    return this._byFilePath.get(filePath) ?? null;
  }
  get size(): number {
    return this._entries.size;
  }

  /** Total number of articles tracked in the registry. */
  getTotalCount(): number {
    return this._entries.size;
  }
  // END_BLOCK_LOOKUPS

  // START_BLOCK_PROTECTION
  isProtected(feedItemId: string, mtime: number): ProtectionResult {
    const entry = this._entries.get(feedItemId);
    if (!entry) return { protected: false };
    if (mtime > entry.lastSyncWriteMtime) {
      logInfo("isProtected:BLOCK_PROTECTION", "PROTECTION_CHECK", "local mtime exceeds lastSyncWriteMtime — protected", {
        feedItemId, articleId: entry.articleId, mtime, lastSyncWriteMtime: entry.lastSyncWriteMtime, reason: "local_edits",
      });
      return { protected: true, reason: "local_edits" };
    }
    return { protected: false };
  }

  isProtectedByPath(filePath: string, mtime: number): ProtectionResult {
    const entry = this._byFilePath.get(filePath);
    if (!entry) return { protected: false };
    return this.isProtected(entry.feedItemId, mtime);
  }
  // END_BLOCK_PROTECTION
}

// START_CHANGE_SUMMARY
// LAST_CHANGE: 2026-05-31 — switch to IFileStorage persistence; add lastSyncStamp; remove SettingsManager dep
// LAST_CHANGE: 2026-06-04 — remove hasBody/dictionaryId from ArticleEntry; add status to PendingArticle; keep getTotalCount
// LAST_CHANGE: 2026-06-04 — rename completed→processed; rename upsertFromArticle→putEntry; add "skipped" status; add feeds field + saveFeedsDelta
// LAST_CHANGE: 2026-06-07 — add isFullUpdate to PendingBatch and PendingContainer for full-update signal propagation
// LAST_CHANGE: 2026-06-07 — add pathMappings field to RegistryFile; add getPathMappings/putPathMappings; update load/flush/clear
// LAST_CHANGE: 2026-06-07 — add fullReset() for full logout cleanup (entries + pathMappings + stamp + feeds + cdn + pending); keep clear() as entries-only for full-update delete-policy compatibility.
// LAST_CHANGE: 2026-06-08 — add removePathMapping(feedItemId) for cleanup after successful delete (UC-016 fix); pathMappings semantics: feedItemId→path (not articleId→path)
// END_CHANGE_SUMMARY
