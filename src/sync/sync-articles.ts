// START_MODULE_CONTRACT
// PURPOSE: Two-phase article sync — fetchDelta() discovers new/changed article IDs + CDN strategy via apiFeedSync, loadBatchById() hydrates by ID via apiFeedLoadById, loadBatchByPrefix() hydrates by prefix via apiFeedLoadByPrefix. Each function is standalone (no class, no Observable streams), uses withRetry for resilience, and keeps structured logging for observability. The orchestrator loops fetchDelta → loadBatchById/loadBatchByPrefix → fetchDelta until the server returns no batches.
// SCOPE: src/sync/sync-articles.ts
// DEPENDS: M-HTTP-HELPER, M-CDN-RESOLVER
// LINKS: UC-003, UC-016, V-M-SYNC-ARTICLES
// ROLE: RUNTIME
// MAP_MODE: EXPORTS
// END_MODULE_CONTRACT

// START_MODULE_MAP
// fetchDelta - call apiFeedSync(stamp, stats), return batches + cdn + feeds + newStamp
// loadBatchById - call apiFeedLoadById(ids, isFullUpdate), return feedItems array
// loadBatchByPrefix - call apiFeedLoadByPrefix(prefixes), return feedItems array
// END_MODULE_MAP

import { firstValueFrom } from "rxjs";
import { withRetry } from "../api/api-helper";
import { SYNC_CHUNK_SIZE, SYNC_TIMEOUT_MS, SYNC_RETRIES, SYNC_RETRY_DELAY_MS } from "../constants";
import type { CdnStrategyLike } from "./cdn-resolver";
import { SyncArticles, SyncStats } from "../api/clientV1_0";
import { generateGuid } from "../utils/guid";

// START_BLOCK_INTERNAL_LOG
function logInfo(
  anchor: string,
  event: string,
  belief: string,
  details: Record<string, unknown> = {},
): void {
  console.debug({
    ts: new Date().toISOString(),
    level: "info",
    anchor,
    module: "M-SYNC-ARTICLES",
    requirement: "UC-003",
    event,
    belief,
    ...details,
  });
}

function logError(
  anchor: string,
  event: string,
  belief: string,
  details: Record<string, unknown> = {},
): void {
  console.error({
    ts: new Date().toISOString(),
    level: "error",
    anchor,
    module: "M-SYNC-ARTICLES",
    requirement: "UC-003",
    event,
    belief,
    ...details,
  });
}
function extractHttpDetails(err: unknown): { httpStatus?: number; responseText?: string } {
  if (err && typeof err === "object") {
    const e = err as Record<string, unknown>;
    return {
      httpStatus: typeof e.status === "number" ? (e.status as number) : undefined,
      responseText: typeof e.response === "string" ? (e.response as string).slice(0, 500) : undefined,
    };
  }
  return {};
}
// END_BLOCK_INTERNAL_LOG



// START_CONTRACT: fetchDelta
// PURPOSE: discover changed article IDs and metadata via apiFeedSync; returns batches for the next phase (loadBatch). Both byId and byPrefix batches are loaded via apiFeedLoadById — the server accepts both IDs and prefix search terms in the same endpoint.
// INPUTS: apiClient — Client_V1_0 instance (or structural equivalent), stamp — last known sync stamp, stats — optional client-side article counts (total / unread) sent as userStats
// OUTPUTS: Promise<{ batches: { type: 'byId', ids: string[] }[]; cdn: CdnStrategyLike | null; feeds: import("../api/clientV1_0").FeedRecord[]; newStamp: number; isFullUpdate: boolean }>
// SIDE_EFFECTS: emits API_SYNC_START / API_SYNC_DONE / API_SYNC_FAILED logs
// LINKS: UC-003, V-M-SYNC-ARTICLES
// END_CONTRACT: fetchDelta
export async function fetchDelta(
  apiClient: import("../api/clientV1_0").Client_V1_0,
  stamp: number,
  stats?: { totalCount: number; unreadCount: number },
): Promise<{
  batches: { type: "byId" | "byPrefix"; ids: string[] }[];
  cdn: CdnStrategyLike | null;
  feeds: import("../api/clientV1_0").FeedRecord[];
  newStamp: number;
  isFullUpdate: boolean;
}> {
  // START_BLOCK_FETCH
  logInfo(
    "fetchDelta:BLOCK_FETCH",
    "API_SYNC_START",
    "calling apiFeedSync with current stamp",
    { stamp },
  );

  try {
    const { totalCount = 0, unreadCount = 0 } = stats ?? {};
    const body = new SyncArticles({
      lastSyncStamp: stamp,
      actions: [],
      clientRequestId: generateGuid(),
      forceFullUpdate: false,
      userStats: new SyncStats({ total: totalCount, unread: unreadCount }),
    });
    const raw$ = apiClient.apiFeedSync(body);
    const retried$ = withRetry(raw$, SYNC_RETRIES, SYNC_RETRY_DELAY_MS);
    const res = await firstValueFrom(retried$);
    // END_BLOCK_FETCH

    // START_BLOCK_MAP
    const newStamp = typeof res?.syncStamp === "number" ? res.syncStamp : stamp;
    const batches: { type: "byId" | "byPrefix"; ids: string[] }[] = [
      ...(res?.loadByIds
        ?.filter((ids): ids is string[] => Array.isArray(ids) && ids.length > 0)
        .map((ids) => ({ type: "byId" as const, ids })) ?? []),
      ...(res?.loadByPrefixes
        ?.filter((ids): ids is string[] => Array.isArray(ids) && ids.length > 0)
        .map((ids) => ({ type: "byPrefix" as const, ids })) ?? []),
    ];
    const cdn: CdnStrategyLike | null = res?.cdn ?? null;
    const feeds: import("../api/clientV1_0").FeedRecord[] = res?.feeds ?? [];
    const isFullUpdate = res?.isFullUpdate === true;

    logInfo(
      "fetchDelta:BLOCK_MAP",
      "API_SYNC_DONE",
      "apiFeedSync returned batches and metadata",
      { stamp, newStamp, batchCount: batches.length, feedCount: feeds.length, hasCdn: cdn !== null, isFullUpdate },
    );

    return { batches, cdn, feeds, newStamp, isFullUpdate };
    // END_BLOCK_MAP
  } catch (err) {
    logError(
      "fetchDelta:BLOCK_FETCH",
      "API_SYNC_FAILED",
      "apiFeedSync failed after retries",
      {
        stamp,
        error: err instanceof Error ? err.message : String(err),
        ...extractHttpDetails(err),
      },
    );
    throw err;
  }
}

// START_CONTRACT: loadBatchById
// PURPOSE: hydrate a single batch of article IDs via apiFeedLoadById
// INPUTS: apiClient — Client_V1_0 instance, ids — string[] of feedItemIds to load, isFullUpdate — boolean telling the server to return full article data
// OUTPUTS: Promise<any[]> — array of FeedItemRecord-like objects from the server
// SIDE_EFFECTS: emits LOAD_BATCH_START / LOAD_BATCH_DONE / LOAD_BATCH_FAILED logs
// LINKS: UC-003, V-M-SYNC-ARTICLES
// END_CONTRACT: loadBatchById
export async function loadBatchById(
  apiClient: import("../api/clientV1_0").Client_V1_0,
  ids: string[],
  isFullUpdate: boolean,
): Promise<any[]> {
  // START_BLOCK_LOAD
  if (!ids.length) {
    logInfo(
      "loadBatchById:BLOCK_LOAD",
      "LOAD_BATCH_SKIP",
      "empty id list — returning empty array",
    );
    return [];
  }

  logInfo(
    "loadBatchById:BLOCK_LOAD",
    "LOAD_BATCH_START",
    "calling apiFeedLoadById",
    { count: ids.length, isFullUpdate },
  );

  try {
    const body: any = { feedItemIds: ids, isFullUpdate };
    const raw$ = apiClient.apiFeedLoadById(body);
    const retried$ = withRetry(raw$, SYNC_RETRIES, SYNC_RETRY_DELAY_MS);
    const res = await firstValueFrom(retried$);

    const items: any[] = res?.feedItems ?? [];

    logInfo(
      "loadBatchById:BLOCK_LOAD",
      "LOAD_BATCH_DONE",
      "apiFeedLoadById returned feed items",
      { requested: ids.length, received: items.length },
    );

    return items;
    // END_BLOCK_LOAD
  } catch (err) {
    logError(
      "loadBatchById:BLOCK_LOAD",
      "LOAD_BATCH_FAILED",
      "apiFeedLoadById failed after retries",
      {
        count: ids.length,
        error: err instanceof Error ? err.message : String(err),
        ...extractHttpDetails(err),
      },
    );
    throw err;
  }
}

// START_CONTRACT: loadBatchByPrefix
// PURPOSE: hydrate a single batch of article prefixes via apiFeedLoadByPrefix
// INPUTS: apiClient — Client_V1_0 instance, prefixes — string[] of feedItem prefixes, isFullUpdate — optional boolean
// OUTPUTS: Promise<any[]> — array of FeedItemRecord-like objects from the server
// SIDE_EFFECTS: emits LOAD_BATCH_START / LOAD_BATCH_DONE / LOAD_BATCH_FAILED logs
// LINKS: UC-003, V-M-SYNC-ARTICLES
// END_CONTRACT: loadBatchByPrefix
export async function loadBatchByPrefix(
  apiClient: import("../api/clientV1_0").Client_V1_0,
  prefixes: string[],
  isFullUpdate?: boolean,
): Promise<any[]> {
  if (!prefixes.length) {
    logInfo(
      "loadBatchByPrefix:BLOCK_LOAD",
      "LOAD_BATCH_SKIP",
      "empty prefix list — returning empty array",
    );
    return [];
  }

  logInfo(
    "loadBatchByPrefix:BLOCK_LOAD",
    "LOAD_BATCH_START",
    "calling apiFeedLoadByPrefix",
    { count: prefixes.length },
  );

  try {
    const body: any = { feedItemPrefixes: prefixes, isFullUpdate: isFullUpdate ?? false };
    const raw$ = apiClient.apiFeedLoadByPrefix(body);
    const retried$ = withRetry(raw$, SYNC_RETRIES, SYNC_RETRY_DELAY_MS);
    const res = await firstValueFrom(retried$);

    const items: any[] = res?.feedItems ?? [];

    logInfo(
      "loadBatchByPrefix:BLOCK_LOAD",
      "LOAD_BATCH_DONE",
      "apiFeedLoadByPrefix returned feed items",
      { requested: prefixes.length, received: items.length },
    );

    return items;
  } catch (err) {
    logError(
      "loadBatchByPrefix:BLOCK_LOAD",
      "LOAD_BATCH_FAILED",
      "apiFeedLoadByPrefix failed after retries",
      {
        count: prefixes.length,
        error: err instanceof Error ? err.message : String(err),
        ...extractHttpDetails(err),
      },
    );
    throw err;
  }
}

// START_CHANGE_SUMMARY
// LAST_CHANGE: 2026-06-01 — rename loadBatch → loadBatchById; add loadBatchByPrefix for prefix-based loading
// LAST_CHANGE: 2026-06-04 — add httpStatus/responseText to error logs for all catch blocks
// LAST_CHANGE: 2026-06-04 — replace plain-object body with SyncArticles DTO; import generateGuid from utils/guid; add stats param with userStats
// LAST_CHANGE: 2026-06-07 — add isFullUpdate param to loadBatchById; include isFullUpdate in request body
// END_CHANGE_SUMMARY
