// START_MODULE_CONTRACT
// PURPOSE: Critical (hot spot ⚠#9). Two-phase sync orchestrator with crash recovery. triggerSync('manual' | 'auto') runs (A) fetchDelta to discover changed IDs, (B) parallel loadBatchById / loadBatchByPrefix to hydrate articles (worker pool, same pattern as Phase C), (C) CDN body download + vault write, (D) pending cleanup. Crash recovery: on start checks pending.json — if found, resumes from the last persisted phase via _processPending. Auth guard, network gate, parallel notifications-sync, delete-policy, and cache-cleanup are carried forward from the M-SYNC-ORCHESTRATOR contract. 401-mid-sync invariant (UC-015): auth subscription sets abort flag checked between phases.
// SCOPE: src/sync/sync-orchestrator.ts
// DEPENDS: M-SYNC-ARTICLES, M-SYNC-FILES, M-ARTICLE-BODY-LOADER, M-DELETE-POLICY-EXECUTOR, M-NETWORK-GATE, M-NETWORK-DETECT, M-AUTH-SERVICE, M-SETTINGS-MANAGER, M-NOTIFICATIONS
// LINKS: UC-003, UC-004, UC-015, UC-016, UC-022, V-M-SYNC-ORCHESTRATOR
// ROLE: RUNTIME
// MAP_MODE: EXPORTS
// END_MODULE_CONTRACT

// START_MODULE_MAP
// SyncProgressPhase - union of phase identifiers emitted during sync pipeline
// SyncProgressEvent - shape of each progress event (phase, messageKey, params)
// SyncResult - aggregate outcome shape returned by triggerSync()
// SyncSource - 'manual' | 'auto' (audit trail for log markers + downstream UI)
// SyncOrchestratorDeps - DI bag wiring all Phase 5/6/10 collaborators
// SyncOrchestrator - class with triggerSync(source), isRunning(), and progress$
// END_MODULE_MAP

import { Subject } from "rxjs";

import type { AuthService } from "../auth/auth-service";
import type { Connection } from "../network/network-detect";
import type { NetworkSetting } from "../network/network-gate";
import type { SettingsManager } from "../settings/settings-manager";
import type { IFileStorage } from "../storage/vault-file-storage";

import type { ArticleBodyLoader } from "./article-body-loader";
import type {
  ArticleRegistry, PendingBatch,
  PendingContainer,
} from "./article-registry";
import type { CacheCleanup } from "./cache-cleanup";
import type { DeletePolicyExecutor } from "./delete-policy-executor";
import type { NotificationsSync } from "../notifications/notifications-sync";

import type { SyncFiles } from "./sync-files";
import { fetchDelta, loadBatchById, loadBatchByPrefix } from "./sync-articles";
import { resolveCdnUrlCandidates, type CdnStrategyLike } from "./cdn-resolver";
import {
  removeAttachments,
} from "./base64-extractor";
import type {
  Article,
} from "./types";
import type { Client_V1_0 } from "../api/clientV1_0";
import { getAdaptiveConcurrency } from "../platform/platform";
import { PENDING_SAVE_INTERVAL } from "../constants";

// START_BLOCK_TYPES
export type SyncSource = "manual" | "auto";

/** Aggregate outcome of triggerSync() — surfaced to UI / commands. */
export interface SyncResult {
  success: boolean;
  written: number;
  skipped: number;
  attachmentsDownloaded: number;
  deleted: number;
  /** Stable error code (UC-015 / UC-009). Undefined when success=true. */
  error?:
    | "no_auth"
    | "NETWORK_BLOCKED"
    | "session_expired"
    | "in_progress"
    | "internal_error";
}

/**
 * DI bag. Every collaborator is the concrete class produced in Phase 5 / 6;
 * tests substitute lightweight stubs by satisfying the structural shape.
 *
 * The two network seams are function objects (isAllowed / getConnection) so
 * tests can pass trivial closures without dragging real navigator wiring.
 */
export interface SyncOrchestratorDeps {
  apiClient: Client_V1_0;
  bodyLoader: ArticleBodyLoader;
  syncFiles: SyncFiles;
  vaultWriter: import("../vault/vault-writer").VaultWriter;
  deletePolicyExecutor: DeletePolicyExecutor;
  networkGate: {
    isAllowed: (setting: NetworkSetting, connection: Connection) => boolean;
  };
  networkDetect: { getConnection: () => Connection };
  auth: AuthService;
  settings: SettingsManager;
  /** Article registry — tracks per-article state for protection checks and cache cleanup coordination. */
  registry: ArticleRegistry;
  /**
   * Optional notifications sync — runs in parallel with the article pipeline.
   * When present, triggerSync fires sync() as a fire-and-forget after auth+gate checks.
   */
  notificationsSync?: NotificationsSync;
  /** Optional cache cleanup — runs after sync completes when limitCacheDays is active. */
  cacheCleanup?: CacheCleanup;
  /** Vault file storage — used for attachment cleanup. */
  storage: IFileStorage;
}

/** Internal shape for server-deleted entries tracked outside the pending container. */
interface ServerDeleteEntry {
  id: string;
  feedItemId: string;
}
// END_BLOCK_TYPES

// START_BLOCK_INTERNAL_LOG
const MODULE_ID = "M-SYNC-ORCHESTRATOR";

function logInfo(
  anchor: string,
  event: string,
  belief: string,
  requirement: string,
  details: Record<string, unknown> = {},
): void {
  console.debug({
    ts: new Date().toISOString(),
    level: "debug",
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

function logError(
  anchor: string,
  event: string,
  belief: string,
  requirement: string,
  details: Record<string, unknown> = {},
): void {
  console.error({
    ts: new Date().toISOString(),
    level: "error",
    anchor,
    module: MODULE_ID,
    requirement,
    event,
    belief,
    ...details,
  });
}
// END_BLOCK_INTERNAL_LOG

const EMPTY_RESULT: Readonly<SyncResult> = Object.freeze({
  success: false,
  written: 0,
  skipped: 0,
  attachmentsDownloaded: 0,
  deleted: 0,
});

// START_BLOCK_PROGRESS_TYPES
export type SyncProgressPhase =
  | "auth_check"
  | "network_check"
  | "fetch_delta"
  | "crash_recovery"
  | "load_batch"
  | "download_write"
  | "delete_policy"
  | "cache_cleanup"
  | "complete"
  | "failed";

export interface SyncProgressEvent {
  phase: SyncProgressPhase;
  messageKey: string;
  params?: Record<string, string>;
}
// END_BLOCK_PROGRESS_TYPES

/** Check whether a FeedItemRecord-like object is a server-side deletion. */
function isServerDeleteItem(item: {
  isDeleted?: boolean;
  feedItemId?: string | undefined;
  articleId?: string | undefined;
}): boolean {
  return item.isDeleted === true;
}

/** Normalise a publishDate value to an ISO string. */
function toDateISO(
  date: Date | string | undefined | null,
): string {
  if (!date) return new Date(0).toISOString();
  if (typeof date === "string") return date;
  try {
    return date instanceof Date && !isNaN(date.getTime())
      ? date.toISOString()
      : new Date(0).toISOString();
  } catch {
    return new Date(0).toISOString();
  }
}

// START_CONTRACT: SyncOrchestrator
// PURPOSE: top-level sync pipeline coordinator
// INPUTS: deps: SyncOrchestratorDeps
// OUTPUTS: class with triggerSync(source), isRunning(), and progress$: Subject<SyncProgressEvent>
// SIDE_EFFECTS: invokes every Phase 5/6 collaborator; subscribes to auth events; emits SYNC_TRIGGERED / SYNC_COMPLETE / SYNC_FAILED markers; emits SyncProgressEvent via progress$ at each phase boundary
// LINKS: UC-003, UC-004, UC-015, V-M-SYNC-ORCHESTRATOR
// END_CONTRACT: SyncOrchestrator
export class SyncOrchestrator {
  private readonly deps: SyncOrchestratorDeps;
  /** Reactive stream of sync progress events — consumed by M-SETTINGS-UI. */
  readonly progress$ = new Subject<SyncProgressEvent>();
  /** In-flight sync promise — used for debounce (return same promise to concurrent callers). */
  private inFlight: Promise<SyncResult> | null = null;
  /**
   * Cancellation flag set by the auth-event subscription on 'session-expired'.
   * Checked between phases. When set the pipeline aborts with session_expired.
   */
  private aborted = false;

  constructor(deps: SyncOrchestratorDeps) {
    this.deps = deps;
  }

  private _emitProgress(phase: SyncProgressPhase, params?: Record<string, string>): void {
    const messageKey = phase === "failed" && params?.reason
      ? `sync_progress.failed.${params.reason}`
      : `sync_progress.${phase}`;
    this.progress$.next({ phase, messageKey, params });
  }

  /** True while an in-flight sync is running. */
  isRunning(): boolean {
    return this.inFlight !== null;
  }

  // START_CONTRACT: triggerSync
  // PURPOSE: run one end-to-end sync; debounce concurrent calls
  // INPUTS: source: SyncSource
  // OUTPUTS: Promise<SyncResult>
  // SIDE_EFFECTS: vault writes / removes / archives via downstream modules; settings persistence; emits SYNC_TRIGGERED / SYNC_COMPLETE / SYNC_FAILED logs
  // LINKS: UC-003, UC-004, UC-015, V-M-SYNC-ORCHESTRATOR
  // END_CONTRACT: triggerSync
  triggerSync(source: SyncSource): Promise<SyncResult> {
    // START_BLOCK_START
    // Debounce: if a sync is already running, return the same Promise.
    // The shape of SyncResult is identical regardless of which caller wins.
    if (this.inFlight !== null) {
      logInfo(
        "triggerSync:BLOCK_START",
        "SYNC_DEBOUNCED",
        "sync already in flight — returning existing promise",
        "UC-003",
        { source },
      );
      return this.inFlight;
    }
    logInfo(
      "triggerSync:BLOCK_START",
      "SYNC_TRIGGERED",
      "starting sync cycle",
      source === "auto" ? "UC-004" : "UC-003",
      { source },
    );
    this.aborted = false;
    const promise = this._run(source).finally(() => {
      this.inFlight = null;
    });
    this.inFlight = promise;
    return promise;
    // END_BLOCK_START
  }

  // Internal — the actual pipeline. Wrapped by triggerSync for inFlight
  // bookkeeping; never call directly.
  private async _run(source: SyncSource): Promise<SyncResult> {
    // Subscribe to auth events for the duration of this sync. The handler
    // sets `this.aborted` so phases can abort cleanly.
    const unsub = this.deps.auth.subscribe((event) => {
      if (event.kind === "session-expired") {
        this.aborted = true;
        logWarn(
          "triggerSync:BLOCK_AUTH_GUARD",
          "SYNC_ABORTED",
          "session-expired received mid-sync — aborting downstream phases",
          "UC-015",
          { source },
        );
      }
    });

    try {
      const result = await this._runPhases(source);
      if (result.success) {
        await this.deps.settings.set("lastSyncError", null);
      } else {
        await this.deps.settings.set("lastSyncError", result.error ?? "internal_error");
      }
      return result;
    } finally {
      try {
        unsub();
      } catch (err) {
        void err;
      }
    }
  }

  private async _runPhases(source: SyncSource): Promise<SyncResult> {
    this._emitProgress("auth_check");
    // START_BLOCK_AUTH_GUARD
    if (!this.deps.auth.isReady()) {
      logWarn(
        "triggerSync:BLOCK_AUTH_GUARD",
        "SYNC_FAILED",
        "auth not ready — graceful no-op",
        "UC-015",
        { source },
      );
      this._emitProgress("failed", { reason: "no_auth" });
      return { ...EMPTY_RESULT, error: "no_auth" };
    }
    // END_BLOCK_AUTH_GUARD

    this._emitProgress("network_check");
    // START_BLOCK_NET_GATE
    const gateSetting = this.deps.settings.get("networkForArticles") as NetworkSetting;
    const connection = this.deps.networkDetect.getConnection();
    if (!this.deps.networkGate.isAllowed(gateSetting, connection)) {
      logWarn(
        "triggerSync:BLOCK_NET_GATE",
        "SYNC_FAILED",
        "network gate denied — aborting before any vault write",
        source === "auto" ? "UC-004" : "UC-003",
        { source, setting: gateSetting, online: connection.online, type: connection.type },
      );
      this._emitProgress("failed", { reason: "network_blocked" });
      return { ...EMPTY_RESULT, error: "NETWORK_BLOCKED" };
    }
    // END_BLOCK_NET_GATE

    this._emitProgress("fetch_delta");
    // START_BLOCK_NOTIFICATIONS_SYNC
    // Fire-and-forget: notifications sync runs in parallel with the article
    // pipeline. We do NOT await it — failures are logged inside the sync
    // module and do not affect the article sync result.
    if (this.deps.notificationsSync && !this.aborted) {
      this.deps.notificationsSync.sync().subscribe({
        error: (err) => {
          logWarn(
            "triggerSync:BLOCK_NOTIFICATIONS_SYNC",
            "NOTIFICATIONS_SYNC_FAILED",
            "parallel notifications sync failed — articles continue",
            "UC-022",
            { error: stringifyError(err) },
          );
        },
      });
    }
    // END_BLOCK_NOTIFICATIONS_SYNC

    // START_BLOCK_CRASH_RECOVERY
    // Check for a pending container from a previous cycle.
    //   processed = false → crash recovery: _processPending not yet run (resume)
    //   processed = true  → _processPending already ran; cdn_failed articles
    //                       remain (fall through to fetchDelta, then merge batches)
    let pending = await this.deps.registry.loadPending();
    let crashWritten = 0;
    let crashSkipped = 0;
    let crashAttachments = 0;
    let crashDeleted = 0;

    if (pending && !pending.processed) {
      logInfo(
        "triggerSync:BLOCK_CRASH_RECOVERY",
        "PENDING_FOUND",
        "pending sync container found (crash) — resuming processing",
        "UC-003",
        { batchCount: pending.batches.length, newStamp: pending.newStamp },
      );
      this._emitProgress("crash_recovery");
      const recoveryCounts = await this._processPending(source, pending);
      if (recoveryCounts.error) {
        return {
          success: false,
          written: recoveryCounts.written,
          skipped: recoveryCounts.skipped,
          attachmentsDownloaded: recoveryCounts.attachmentsDownloaded,
          deleted: recoveryCounts.deleted,
          error: recoveryCounts.error,
        };
      }
      if (this.aborted) {
        return {
          success: false,
          written: recoveryCounts.written,
          skipped: recoveryCounts.skipped,
          attachmentsDownloaded: recoveryCounts.attachmentsDownloaded,
          deleted: recoveryCounts.deleted,
          error: "session_expired",
        };
      }
      crashWritten = recoveryCounts.written;
      crashSkipped = recoveryCounts.skipped;
      crashAttachments = recoveryCounts.attachmentsDownloaded;
      crashDeleted = recoveryCounts.deleted;
    }
    // END_BLOCK_CRASH_RECOVERY

    // ---- Phase A: fetchDelta ----
    // START_BLOCK_PHASE_A
    let result: Awaited<ReturnType<typeof fetchDelta>>;
    try {
      result = await fetchDelta(this.deps.apiClient, this.deps.registry.lastSyncStamp, {
        totalCount: this.deps.registry.getTotalCount(),
        unreadCount: 0,
      });
    } catch (err: unknown) {
      if (this.aborted || isUnauthorized(err)) {
        logError(
          "triggerSync:BLOCK_PHASE_A",
          "SYNC_FAILED",
          "fetchDelta ended with 401 / session-expired",
          "UC-015",
          { source, error: stringifyError(err) },
        );
        this._emitProgress("failed", { reason: "session_expired" });
        return { ...EMPTY_RESULT, error: "session_expired" };
      }
      logError(
        "triggerSync:BLOCK_PHASE_A",
        "SYNC_FAILED",
        "fetchDelta errored — aborting sync",
        "UC-003",
        { source, error: stringifyError(err) },
      );
      this._emitProgress("failed", { reason: "internal_error" });
      return { ...EMPTY_RESULT, error: "internal_error" };
    }

    if (this.aborted) {
      this._emitProgress("failed", { reason: "session_expired" });
      return { ...EMPTY_RESULT, error: "session_expired" };
    }

    // First sync (no prior stamp) always sends isFullUpdate=true to get complete data.
    // On subsequent syncs, follow the server's signal from fetchDelta.
    const isFirstSync = this.deps.registry.lastSyncStamp === 0;
    const effectiveIsFullUpdate = isFirstSync ? true : result.isFullUpdate;

    logInfo(
      "triggerSync:BLOCK_PHASE_A",
      "SYNC_DELTA_MODE",
      "sync delta mode computed",
      "UC-003",
      { source, isFirstSync, lastSyncStamp: this.deps.registry.lastSyncStamp, effectiveIsFullUpdate, serverIsFullUpdate: result.isFullUpdate },
    );

    // Full update: clear existing entries — server signals full snapshot,
    // or this is the first sync (no prior stamp → force full update).
    if (effectiveIsFullUpdate) {
      logInfo("triggerSync:BLOCK_PHASE_A", "SYNC_FULL_UPDATE", "server signaled full update — clearing registry", "UC-003", { source });
      pending = null;
      await this.deps.registry.clearPending();
      await this.deps.registry.clear();
    }

    // If server sent a new CDN config, update the global one in registry.
    if (result.cdn) {
      this.deps.registry.cdnConfig = result.cdn;
    }

    // Apply feed delta from server.
    this.deps.registry.saveFeedsDelta(result.feeds ?? [], effectiveIsFullUpdate);

    // Build the batch list for the pending container.
    // Old processed-pending batches first (status="loaded", articles intact),
    // then new batches from the current fetchDelta (status="pending", fresh).
    const containerBatches: PendingBatch[] = [];
    if (pending && pending.processed) {
      for (const b of pending.batches) {
        containerBatches.push(b);
      }
    }
    for (const b of result.batches) {
      containerBatches.push({ type: b.type, ids: b.ids, status: "pending" as const, isFullUpdate: effectiveIsFullUpdate });
    }

    // No batches from either source — fast-path to cache cleanup.
    if (containerBatches.length === 0) {
      logInfo(
        "triggerSync:BLOCK_PHASE_A",
        "SYNC_NO_NEW",
        "no article batches to process",
        "UC-003",
        { source },
      );
      return await this._finishCleanup(source, crashWritten, crashSkipped, crashAttachments, crashDeleted);
    }
    // END_BLOCK_PHASE_A

    // Build the pending container and persist it atomically.
    // START_BLOCK_PERSIST_PENDING
    const pendingContainer: PendingContainer = {
      batches: containerBatches,
      newStamp: result.newStamp,
      isFullUpdate: effectiveIsFullUpdate,
    };

    this.deps.registry.lastSyncStamp = pendingContainer.newStamp;
    await this.deps.registry.savePending(pendingContainer);
    await this.deps.registry.flush();
    // END_BLOCK_PERSIST_PENDING

    // ---- Phase B + C + D + deletes ----
    const counts = await this._processPending(source, pendingContainer);
    if (counts.error) {
      this._emitProgress("failed", { reason: counts.error });
      return {
        success: false,
        written: counts.written + crashWritten,
        skipped: counts.skipped + crashSkipped,
        attachmentsDownloaded: counts.attachmentsDownloaded + crashAttachments,
        deleted: counts.deleted + crashDeleted,
        error: counts.error,
      };
    }
    if (this.aborted) {
      this._emitProgress("failed", { reason: "session_expired" });
      return {
        success: false,
        written: counts.written + crashWritten,
        skipped: counts.skipped + crashSkipped,
        attachmentsDownloaded: counts.attachmentsDownloaded + crashAttachments,
        deleted: counts.deleted + crashDeleted,
        error: "session_expired",
      };
    }
    // ---- Cache cleanup + final log ----
    return await this._finishCleanup(
      source,
      counts.written + crashWritten,
      counts.skipped + crashSkipped,
      counts.attachmentsDownloaded + crashAttachments,
      counts.deleted + crashDeleted,
    );
  }

  /**
   * Crash-recovery / continuation pipeline. Processes a PendingContainer
   * through phases B (load batches), C (download + write), D (clear pending),
   * then delete-policy. Does NOT emit "complete" progress or run cache-cleanup
   * — those are done by the caller (_runPhases) via _finishCleanup.
   */
  private async _processPending(
    source: SyncSource,
    pending: PendingContainer,
  ): Promise<Pick<SyncResult, "written" | "skipped" | "attachmentsDownloaded" | "deleted"> & { error?: SyncResult["error"] }> {
    let written = 0;
    let skipped = 0;
    let attachmentsDownloaded = 0;
    let deleted = 0;
    const pendingServerDeletes: ServerDeleteEntry[] = [];
    const isAborted = (): boolean => this.aborted;
    const emitProgress = this._emitProgress.bind(this);

    // Build feed name map from the feeds data in registry.
    const feedNames: Record<string, string> = {};
    for (const feed of this.deps.registry.feeds) {
      if (feed.feedId) feedNames[feed.feedId] = feed.title ?? "(unknown feed)";
    }

    // START_BLOCK_PHASE_B
    // Load batches in parallel — each batch is independent.
    // Workers claim batches via atomic counter, same pattern as Phase C.
    let batchIdx = 0;
    let batchError: string | null = null;
    const batchesTotal = pending.batches.length;
    const loaderConcurrency = Math.max(1, Math.min(getAdaptiveConcurrency(), batchesTotal));
    let saveLock = false;
    let batchProcessedSinceSave = 0;
    const deps = this.deps;

    async function batchWorker(): Promise<void> {
      for (let i = batchIdx++; i < batchesTotal; i = batchIdx++) {
        if (isAborted() || batchError) return;

        const batch = pending.batches[i]!;
        emitProgress("load_batch", { current: String(i + 1), total: String(batchesTotal) });

        if (batch.status === "loaded") continue;

        let items: any[];
        try {
          const batchIsFullUpdate = batch.isFullUpdate ?? pending.isFullUpdate ?? false;
          items = batch.type === "byPrefix"
            ? await loadBatchByPrefix(deps.apiClient, batch.ids, batchIsFullUpdate)
            : await loadBatchById(deps.apiClient, batch.ids, batchIsFullUpdate);
        } catch (err: unknown) {
          if (isAborted() || isUnauthorized(err)) {
            batchError = "session_expired";
          } else {
            logError(
              "_processPending:BLOCK_PHASE_B",
              "LOAD_BATCH_FAILED",
              "loadBatchById / loadBatchByPrefix errored — aborting",
              "UC-003",
              { error: stringifyError(err) },
            );
            batchError = "internal_error";
          }
          return;
        }

        const liveArticles: import("./article-registry").PendingArticle[] = [];
        for (const item of items) {
          if (isServerDeleteItem(item)) {
            pendingServerDeletes.push({
              id: item.articleId,
              feedItemId: item.feedItemId ?? item.articleId,
            });
          } else {
            liveArticles.push({
              feedItemId: item.feedItemId,
              articleId: item.articleId,
              url: item.source,
              title: item.title,
              feedId: item.feedId,
              feedName: feedNames[item.feedId] ?? "(unknown feed)",
              date: toDateISO(item.publishDate),
              tags: item.tags ?? [],
              notes: item.notes ?? [],
              haveStar: item.haveStar,
              dictionaryId: item.dictionaryId,
            });
          }
        }

        batch.articles = liveArticles;
        batch.status = "loaded";

        // Serialize savePending to avoid concurrent JSON writes.
        while (saveLock) { await new Promise(r => setTimeout(r, 1)); }
        saveLock = true;
        try {
          batchProcessedSinceSave++;
          if (batchProcessedSinceSave >= PENDING_SAVE_INTERVAL) {
            batchProcessedSinceSave = 0;
            await deps.registry.savePending(pending);
          }
        } finally {
          saveLock = false;
        }
      }
    }

    const loaders: Promise<void>[] = [];
    for (let i = 0; i < loaderConcurrency; i++) {
      loaders.push(batchWorker());
    }
    await Promise.all(loaders);

    // Final save to persist any unpersisted loaded batches.
    await deps.registry.savePending(pending);

    if (batchError) {
      emitProgress("failed", { reason: batchError as "session_expired" | "internal_error" });
      return { written, skipped, attachmentsDownloaded, deleted, error: batchError as SyncResult["error"] };
    }
    if (isAborted()) {
      emitProgress("failed", { reason: "session_expired" });
      return { written, skipped, attachmentsDownloaded, deleted };
    }
    // END_BLOCK_PHASE_B

    // START_BLOCK_PHASE_C
    this.deps.storage.resetMkdirCache();
    const totalArticles = pending.batches.reduce((s, b) => s + (b.articles?.length ?? 0), 0);
    this._emitProgress("download_write", { written: "0", total: String(totalArticles) });
    // Per-article pipeline: gate → download → write.
    // Workers process one article at a time; only `concurrency` HTML bodies in memory.
    const concurrency = Math.max(1, getAdaptiveConcurrency());

    // Flatten all articles with batch index so workers can reference batch for status updates.
    interface FlatArticle { batchIdx: number; article: import("./article-registry").PendingArticle; }
    const allArticles: FlatArticle[] = [];
    for (let bi = 0; bi < pending.batches.length; bi++) {
      const batch = pending.batches[bi]!;
      if (!batch.articles) continue;
      for (const a of batch.articles) {
        allArticles.push({ batchIdx: bi, article: a });
      }
    }

    let flatIdx = 0;
    let processedSinceSave = 0;

    async function articleWorker(
      loader: ArticleBodyLoader,
      cdn: CdnStrategyLike | null,
      settings: SettingsManager,
      registry: ArticleRegistry,
      syncFiles: SyncFiles,
    ): Promise<void> {
      while (flatIdx < allArticles.length) {
        const fi = flatIdx++;
        const { article } = allArticles[fi]!;
        if (isAborted()) break;

        // Already written in this sync cycle.
        if (article.status === "written") continue;
        // Already exists from a previous sync.
        if (registry.get(article.feedItemId)) {
          logInfo(
            "_processPending:BLOCK_PHASE_C",
            "REGISTRY_HIT_SKIP",
            "article already in registry — skipping re-write",
            "UC-003",
            { feedItemId: article.feedItemId, articleId: article.articleId, reason: "existing_entry" },
          );
          article.status = "skipped";
          skipped++;
          continue;
        }
        // Favorites-only filter.
        if (settings.get("syncFavoritesOnly") && !article.haveStar) {
          article.status = "skipped";
          skipped++;
          continue;
        }
        // No dictionaryId → can't download CDN body → skip.
        if (!article.dictionaryId) {
          article.status = "skipped";
          skipped++;
          continue;
        }

        // START_BLOCK_PER_ARTICLE_DOWNLOAD
        if (isAborted()) break;
        const html = await loader.load(article.articleId, article.dictionaryId, cdn);
        if (!html) {
          article.status = "cdn_failed";
          skipped++;
          continue;
        }
        // END_BLOCK_PER_ARTICLE_DOWNLOAD

        // START_BLOCK_PER_ARTICLE_WRITE
        if (isAborted()) break;
        const articleObj: Article = {
          id: article.articleId,
          feedItemId: article.feedItemId,
          title: article.title,
          url: article.url,
          date: article.date,
          tags: article.tags,
          notes: article.notes,
          bodyHtml: html,
          feedName: article.feedName,
          feedId: article.feedId,
          haveStar: article.haveStar,
        };

        try {
          const writeResult = await syncFiles.processArticle(articleObj);
          if (writeResult.skipped) {
            skipped++;
          } else {
            written++;
            emitProgress("download_write", { written: String(written), total: String(totalArticles) });
            if (writeResult.attachments?.length) {
              attachmentsDownloaded += writeResult.attachments.length;
            }
            registry.putEntry({
              feedItemId: article.feedItemId,
              articleId: article.articleId,
              filePath: writeResult.finalPath!,
              haveStar: article.haveStar,
              hasNotes: article.notes.length > 0,
              lastSyncWriteMtime: Date.now(),
              _attachments: writeResult.attachments ?? [],
            });
            article.status = "written";
          }
        } catch (err) {
          logWarn(
            "_processPending:BLOCK_PHASE_C",
            "WRITE_FAILED",
            "processArticle threw — skipping article",
            "UC-003",
            { feedItemId: article.feedItemId, error: stringifyError(err) },
          );
          skipped++;
        }
        // END_BLOCK_PER_ARTICLE_WRITE

        // START_BLOCK_PER_ARTICLE_SAVE
        processedSinceSave++;
        if (processedSinceSave >= PENDING_SAVE_INTERVAL) {
          processedSinceSave = 0;
          await registry.savePending(pending);
        }
        // END_BLOCK_PER_ARTICLE_SAVE
      }
    }

    const workers: Promise<void>[] = [];
    const workerCount = Math.min(concurrency, allArticles.length);
    const syncFiles = this.deps.syncFiles;
    for (let i = 0; i < workerCount; i++) {
      workers.push(articleWorker(
        this.deps.bodyLoader, this.deps.registry.cdnConfig,
        this.deps.settings, this.deps.registry,
        syncFiles,
      ));
    }
    await Promise.all(workers);
    this.deps.storage.resetMkdirCache();

    // If session expired fired during processing — report immediate abort.
    if (this.aborted) {
      this._emitProgress("failed", { reason: "session_expired" });
      return { written, skipped, attachmentsDownloaded, deleted };
    }
    // END_BLOCK_PHASE_C

    // START_BLOCK_PHASE_D
    // Check if any articles still need CDN retry.
    let hasCdnFailures = false;
    for (const batch of pending.batches) {
      for (const a of batch.articles ?? []) {
        if (a.status === "cdn_failed") { hasCdnFailures = true; break; }
      }
      if (hasCdnFailures) break;
    }

    if (hasCdnFailures) {
      logInfo(
        "_processPending:BLOCK_PHASE_D",
        "PENDING_KEPT",
        "articles with CDN failures remain — keeping pending for retry next sync",
        "UC-003",
        { remainingCdnFailures: pending.batches.reduce((s, b) => s + (b.articles?.filter(a => a.status === "cdn_failed").length ?? 0), 0) },
      );
      pending.processed = true;
      await this.deps.registry.savePending(pending);
    } else {
      await this.deps.registry.clearPending();
    }
    await this.deps.registry.flush();
    // END_BLOCK_PHASE_D

    // ---- Delete policy phase ----
    this._emitProgress("delete_policy");
    deleted = await this._applyDeletePolicy(pendingServerDeletes);

    return { written, skipped, attachmentsDownloaded, deleted };
  }

  /** Common clean-up: cache cleanup + final log + SyncResult. */
  private async _finishCleanup(
    source: SyncSource,
    written: number,
    skipped: number,
    attachmentsDownloaded: number,
    deleted: number,
  ): Promise<SyncResult> {
    this._emitProgress("cache_cleanup");
    // START_BLOCK_CACHE_CLEANUP
    if (this.deps.cacheCleanup && !this.aborted) {
      const limitCacheDays = this.deps.settings.get("limitCacheDays");
      if (limitCacheDays !== "off") {
        try {
          const result = await this.deps.cacheCleanup.scan();
          logInfo(
            "triggerSync:BLOCK_CACHE_CLEANUP",
            "CACHE_CLEANUP_COMPLETE",
            "cache cleanup scan finished after sync",
            "UC-011",
            { ...result },
          );
        } catch (err) {
          logWarn(
            "triggerSync:BLOCK_CACHE_CLEANUP",
            "CACHE_CLEANUP_FAILED",
            "cache cleanup threw — sync result unaffected",
            "UC-011",
            { error: stringifyError(err) },
          );
        }
      }
    }
    // END_BLOCK_CACHE_CLEANUP

    // START_BLOCK_COMPLETE
    this._emitProgress("complete", {
      written: String(written),
      skipped: String(skipped),
    });
    logInfo(
      "triggerSync:BLOCK_COMPLETE",
      "SYNC_COMPLETE",
      "sync finished successfully",
      source === "auto" ? "UC-004" : "UC-003",
      { source, written, skipped, attachmentsDownloaded, deleted },
    );
    return {
      success: true,
      written,
      skipped,
      attachmentsDownloaded,
      deleted,
    };
    // END_BLOCK_COMPLETE
  }

  /** Apply the user's delete-policy on known server-side deletions. */
  private async _applyDeletePolicy(
    deletes: ServerDeleteEntry[],
  ): Promise<number> {
    if (this.aborted || deletes.length === 0) return 0;

    // START_BLOCK_DELETES
    const policy = this.deps.settings.get("deletePolicy");
    const mappings = this.deps.registry.getPathMappings();
    let deleted = 0;

    for (const entry of deletes) {
      if (this.aborted) break;

      const finalPath = mappings[entry.feedItemId];
      if (!finalPath) {
        logWarn(
          "_processPending:BLOCK_DELETES",
          "DELETE_NO_MAPPING",
          "no pathMappings entry for feedItemId — skipping policy apply",
          "UC-016",
          { feedItemId: entry.feedItemId, articleId: entry.id },
        );
        continue;
      }

      const registryEntry = this.deps.registry.get(entry.feedItemId);
      const excludeFavorites = this.deps.settings.get("cleanupExcludeFavorites");
      const excludeWithNotes = this.deps.settings.get("cleanupExcludeWithNotes");
      if (registryEntry && excludeFavorites && registryEntry.haveStar) {
        logInfo(
          "_processPending:BLOCK_DELETES",
          "DELETE_PROTECTED",
          "article is favorited — skipping deletion",
          "UC-016",
          { feedItemId: entry.feedItemId, finalPath, reason: "favorited" },
        );
        continue;
      }
      if (registryEntry && excludeWithNotes && registryEntry.hasNotes) {
        logInfo(
          "_processPending:BLOCK_DELETES",
          "DELETE_PROTECTED",
          "article has notes — skipping deletion",
          "UC-016",
          { feedItemId: entry.feedItemId, finalPath, reason: "has_notes" },
        );
        continue;
      }

      try {
        const r = await this.deps.deletePolicyExecutor.apply(
          { id: entry.feedItemId, finalPath, lastSyncWriteMtime: registryEntry?.lastSyncWriteMtime },
          policy,
        );
        if (r.action === "deleted") {
          deleted += 1;
          if (registryEntry?._attachments?.length) {
            await removeAttachments(registryEntry._attachments, this.deps.storage);
          }
          if (registryEntry) this.deps.registry.remove(registryEntry.feedItemId);
          this.deps.registry.removePathMapping(entry.feedItemId);
        }
      } catch (err) {
        logWarn(
          "_processPending:BLOCK_DELETES",
          "POLICY_APPLY_ERROR",
          "policy executor threw — skipping article",
          "UC-016",
          { feedItemId: entry.feedItemId, error: stringifyError(err) },
        );
      }
    }
    // END_BLOCK_DELETES
    return deleted;
  }
}

// START_BLOCK_HELPERS
function isUnauthorized(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const v = (err as { status?: unknown }).status;
  return typeof v === "number" && v === 401;
}

function stringifyError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err && typeof err === "object") {
    try {
      return JSON.stringify(err);
    } catch {
      return String(err);
    }
  }
  return String(err);
}
// END_BLOCK_HELPERS

// START_CHANGE_SUMMARY
// LAST_CHANGE: 2026-06-07 — parallelize Phase B batch loading: replace sequential for-of with worker pool (atomic batchIdx + Promise.all), mutex-guarded savePending, shared batchError for coordinated abort
// LAST_CHANGE: 2026-06-07 — Scenario B: remove return after crash recovery → continue to fetchDelta; pass source through _processPending → _finishCleanup; lift _finishCleanup out of _processPending into _runPhases to avoid double cache-cleanup
// LAST_CHANGE: 2026-06-07 — wire isFullUpdate through sync pipeline: detect first sync (lastSyncStamp===0) → true; propagate through PendingContainer/PendingBatch → loadBatchById/loadBatchByPrefix
// LAST_CHANGE: 2026-06-01 — add byPrefix dispatch for loadBatchByPrefix in Phase B; rename loadBatch → loadBatchById
// LAST_CHANGE: 2026-06-01 — logInfo: console.info → console.debug
// LAST_CHANGE: 2026-06-01 — add syncFavoritesOnly filter in PHASE_C
// LAST_CHANGE: 2026-06-02 — add SyncProgressPhase/SyncProgressEvent types + progress$ Subject; emit at each phase boundary
// LAST_CHANGE: 2026-06-04 — set/clear lastSyncError on sync result (set on failure, clear on success)
// LAST_CHANGE: 2026-06-04 — restructure to per-article pipeline; CDN failures via PendingArticle.status; clearPending only if all written
// LAST_CHANGE: 2026-06-04 — move CDN to global registry.cdnConfig + immediate flush; remove repair; rename completed→processed; remove triedCdnUrls
// LAST_CHANGE: 2026-06-04 — add "skipped" status; feeds in registry.saveFeedsDelta; savePending every PENDING_SAVE_INTERVAL; upsertFromArticle→putEntry
// LAST_CHANGE: 2026-06-07 — use registry.getPathMappings() instead of settings.get("pathMappings") in _applyDeletePolicy
// LAST_CHANGE: 2026-06-08 — migrate delete lookup from entry.id (articleId, may be null) to entry.feedItemId (always present); move getPathMappings outside loop; call removePathMapping after successful delete (UC-016 fix)
// LAST_CHANGE: 2026-06-08 — pass registryEntry.lastSyncWriteMtime to deletePolicyExecutor.apply()  (UC-016 fix)
// LAST_CHANGE: 2026-06-07 — call storage.resetMkdirCache() before/after Phase C to deduplicate adapter.mkdir within batch
// END_CHANGE_SUMMARY
