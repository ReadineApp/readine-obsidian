// START_MODULE_CONTRACT
// PURPOSE: Critical-tier tests for M-SYNC-ARTICLES — fetchDelta maps apiFeedSync response to batches/cdn/feeds/newStamp; loadBatchById hydrates IDs via apiFeedLoadById; error propagation; empty response edge cases.
// SCOPE: src/sync/sync-articles.test.ts
// DEPENDS: M-SYNC-ARTICLES
// LINKS: V-M-SYNC-ARTICLES
// ROLE: TEST
// END_MODULE_CONTRACT

// START_MODULE_MAP
// (test file — no public exports)
// END_MODULE_MAP

import { afterEach, describe, expect, it, vi } from "vitest";
import { of, throwError } from "rxjs";
import { firstValueFrom } from "rxjs";

import { fetchDelta, loadBatchById, loadBatchByPrefix } from "./sync-articles";
import type { CdnStrategyLike } from "./cdn-resolver";

vi.mock("obsidian", () => import("../__mocks__/obsidian"));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a minimal Client_V1_0-like stub. */
function stubClient(overrides?: Record<string, any>): any {
  const api: Record<string, any> = {
    apiFeedSync: () => of({}),
    apiFeedLoadById: () => of({}),
    apiFeedLoadByPrefix: () => of({}),
    apiAccountObsidianLogin: () => of({}),
    apiNotificationsSync: () => of({}),
    apiAccountLogout: () => of(true),
  };
  if (overrides?.apiFeedSync) api.apiFeedSync = overrides.apiFeedSync;
  if (overrides?.apiFeedLoadById) api.apiFeedLoadById = overrides.apiFeedLoadById;
  if (overrides?.apiFeedLoadByPrefix) api.apiFeedLoadByPrefix = overrides.apiFeedLoadByPrefix;
  return api;
}

describe("M-SYNC-ARTICLES (V-M-SYNC-ARTICLES)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // SyncArticles DTO construction
  // -------------------------------------------------------------------------

  it("fetchDelta: sends SyncArticles DTO with clientRequestId and userStats", async () => {
    const apiFeedSyncSpy = vi.fn().mockReturnValue(of({ syncStamp: 1 }));
    const client = stubClient({ apiFeedSync: apiFeedSyncSpy });
    await fetchDelta(client, 0, { totalCount: 5, unreadCount: 2 });
    expect(apiFeedSyncSpy).toHaveBeenCalledTimes(1);
    const body = apiFeedSyncSpy.mock.calls[0]![0]!;
    // Should be a SyncArticles DTO with a valid UUID clientRequestId
    const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
    expect(body.clientRequestId).toMatch(uuidRe);
    expect(body.forceFullUpdate).toBe(false);
    expect(body.lastSyncStamp).toBe(0);
    expect(body.userStats).toBeDefined();
    const stats = body.userStats!;
    expect(stats.total).toBe(5);
    expect(stats.unread).toBe(2);
  });

  // -------------------------------------------------------------------------
  // fetchDelta
  // -------------------------------------------------------------------------

  it("fetchDelta: returns batches from loadByIds", async () => {
    const client = stubClient({
      apiFeedSync: () =>
        of({
          syncStamp: 42,
          loadByIds: [["id1", "id2"], ["id3"]],
          feeds: [{ feedId: "f1", title: "Feed 1" }],
          cdn: null,
        }),
    });
    const result = await fetchDelta(client, 0);
    expect(result.batches).toEqual([
      { type: "byId", ids: ["id1", "id2"] },
      { type: "byId", ids: ["id3"] },
    ]);
    expect(result.newStamp).toBe(42);
    expect(result.feeds).toHaveLength(1);
    expect(result.cdn).toBeNull();
  });

  it("fetchDelta: returns empty batches when loadByIds is undefined", async () => {
    const client = stubClient({
      apiFeedSync: () => of({ syncStamp: 10 }),
    });
    const result = await fetchDelta(client, 0);
    expect(result.batches).toEqual([]);
    expect(result.newStamp).toBe(10);
  });

  it("fetchDelta: uses input stamp when syncStamp is undefined", async () => {
    const client = stubClient({
      apiFeedSync: () => of({}),
    });
    const result = await fetchDelta(client, 99);
    expect(result.newStamp).toBe(99);
  });

  it("fetchDelta: includes cdn strategy when present", async () => {
    const cdn: CdnStrategyLike = {
      orderStrategy: 10,
      filenameStrategy: 100,
      configs: [
        { url: "https://cdn.example.com", headers: { Authorization: "Bearer x" }, maxRetry: 3 } as any,
      ],
    };
    const client = stubClient({
      apiFeedSync: () =>
        of({
          syncStamp: 1,
          cdn: cdn as any,
          loadByIds: [],
          feeds: [],
        }),
    });
    const result = await fetchDelta(client, 0);
    expect(result.cdn).toEqual(cdn);
  });

  it("fetchDelta: propagates error from apiFeedSync", async () => {
    const client = stubClient({
      apiFeedSync: () => throwError(() => new Error("network failure")),
    });
    await expect(fetchDelta(client, 0)).rejects.toThrow("network failure");
  }, 20000);

  // -------------------------------------------------------------------------
  // loadBatchById
  // -------------------------------------------------------------------------

  it("loadBatchById: returns feedItems from apiFeedLoadById", async () => {
    const items = [{ feedItemId: "fi-1" }, { feedItemId: "fi-2" }];
    const client = stubClient({
      apiFeedLoadById: () => of({ feedItems: items }),
    });
    const result = await loadBatchById(client, ["id1", "id2"], false);
    expect(result).toEqual(items);
  });

  it("loadBatchById: returns empty array when feedItems is undefined", async () => {
    const client = stubClient({
      apiFeedLoadById: () => of({}),
    });
    const result = await loadBatchById(client, ["id1"], false);
    expect(result).toEqual([]);
  });

  it("loadBatchById: returns empty array when ids is empty", async () => {
    const spy = vi.fn(() => of({ feedItems: [] }));
    const client = stubClient({ apiFeedLoadById: spy });
    const result = await loadBatchById(client, [], false);
    expect(result).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
  });

  it("loadBatchById: propagates error from apiFeedLoadById", async () => {
    const client = stubClient({
      apiFeedLoadById: () => throwError(() => new Error("server error")),
    });
    await expect(loadBatchById(client, ["id1"], false)).rejects.toThrow("server error");
  }, 15000);

  // -------------------------------------------------------------------------
  // loadBatchByPrefix
  // -------------------------------------------------------------------------

  it("loadBatchByPrefix: returns feedItems from apiFeedLoadByPrefix", async () => {
    const items = [{ feedItemId: "fi-1" }, { feedItemId: "fi-2" }];
    const client = stubClient({
      apiFeedLoadByPrefix: () => of({ feedItems: items }),
    });
    const result = await loadBatchByPrefix(client, ["prefix1", "prefix2"]);
    expect(result).toEqual(items);
  });

  it("loadBatchByPrefix: returns empty array when feedItems is undefined", async () => {
    const client = stubClient({
      apiFeedLoadByPrefix: () => of({}),
    });
    const result = await loadBatchByPrefix(client, ["prefix1"]);
    expect(result).toEqual([]);
  });

  it("loadBatchByPrefix: returns empty array when prefixes is empty", async () => {
    const spy = vi.fn(() => of({ feedItems: [] }));
    const client = stubClient({ apiFeedLoadByPrefix: spy });
    const result = await loadBatchByPrefix(client, []);
    expect(result).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
  });

  it("loadBatchByPrefix: propagates error from apiFeedLoadByPrefix", async () => {
    const client = stubClient({
      apiFeedLoadByPrefix: () => throwError(() => new Error("server error")),
    });
    await expect(loadBatchByPrefix(client, ["prefix1"])).rejects.toThrow("server error");
  }, 15000);
});

// START_CHANGE_SUMMARY
// LAST_CHANGE: 2026-06-01 — rename loadBatch → loadBatchById; add loadBatchByPrefix tests
// LAST_CHANGE: 2026-06-07 — add isFullUpdate: false to all loadBatchById test calls
// END_CHANGE_SUMMARY
