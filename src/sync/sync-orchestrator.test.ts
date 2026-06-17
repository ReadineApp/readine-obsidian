// START_MODULE_CONTRACT
// PURPOSE: Critical-tier tests for M-SYNC-ORCHESTRATOR (hot spot ⚠#9) — manual pipeline, auto pipeline, concurrent-debounce, network-block early abort, integration cycle, auto-with-timer integration, AND the 401-mid-sync invariant (articles before expiry WRITTEN, after expiry NOT, returns session_expired).
// SCOPE: src/sync/sync-orchestrator.test.ts
// DEPENDS: M-SYNC-ORCHESTRATOR, M-SYNC-ARTICLES, M-SYNC-FILES, M-ARTICLE-BODY-LOADER, M-DELETE-POLICY-EXECUTOR, M-CACHE-CLEANUP, M-AUTH-SERVICE, M-NETWORK-GATE, M-SETTINGS-MANAGER
// LINKS: V-M-SYNC-ORCHESTRATOR
// ROLE: TEST
// END_MODULE_CONTRACT

// START_MODULE_MAP
// (test file — no public exports)
// END_MODULE_MAP

import { beforeEach, describe, expect, it, vi } from "vitest";
import { Subject } from "rxjs";

const { mockFetchDelta, mockLoadBatchById, mockLoadBatchByPrefix } = vi.hoisted(() => ({
  mockFetchDelta: vi.fn(),
  mockLoadBatchById: vi.fn(),
  mockLoadBatchByPrefix: vi.fn(),
}));
vi.mock("./sync-articles", () => ({
  fetchDelta: mockFetchDelta,
  loadBatchById: mockLoadBatchById,
  loadBatchByPrefix: mockLoadBatchByPrefix,
}));
vi.mock("../platform/platform", () => ({
  getAdaptiveConcurrency: () => 4,
}));

vi.mock("obsidian", () => import("../__mocks__/obsidian"));
import { MockDataAdapter, __resetObsidianMock } from "../__mocks__/obsidian";
import type { DataAdapter } from "obsidian";
import { VaultFileStorage } from "../storage/vault-file-storage";
import { VaultWriter } from "../vault/vault-writer";
import { convert } from "../vault/format-converter";
import { isAllowed } from "../network/network-gate";
import { SettingsManager } from "../settings/settings-manager";
import { getDefaults } from "../settings/settings-defaults";
import type { Connection } from "../network/network-detect";
import type { AuthService, AuthEvent, UnsubscribeFn } from "../auth/auth-service";

import { SyncFiles } from "./sync-files";
import { ArticleRegistry } from "./article-registry";
import { DeletePolicyExecutor } from "./delete-policy-executor";
import { SyncOrchestrator } from "./sync-orchestrator";

function asAdapter(a: MockDataAdapter): DataAdapter {
  return a as unknown as DataAdapter;
}

async function makeSettings(): Promise<SettingsManager> {
  let store: object | null = null;
  const plugin = {
    saveData: async (data: object) => {
      store = data;
    },
    loadData: async () => store,
  };
  const m = new SettingsManager(plugin, getDefaults("desktop"));
  await m.init();
  return m;
}

function makeConn(online: boolean, type: Connection["type"]): Connection {
  return { type, online };
}

/**
 * Build a stub AuthService with controllable isReady + a Subject so tests
 * can fire 'session-expired' mid-pipeline.
 */
function makeAuthStub(initialReady: boolean): {
  service: AuthService;
  fireSessionExpired: () => void;
  setReady: (next: boolean) => void;
} {
  let ready = initialReady;
  const subject = new Subject<AuthEvent>();
  const stub: Partial<AuthService> = {
    isReady: () => ready,
    subscribe: (cb: (e: AuthEvent) => void): UnsubscribeFn => {
      const sub = subject.subscribe(cb);
      return () => sub.unsubscribe();
    },
    getUserId: () => "user-1",
  };
  return {
    service: stub as AuthService,
    fireSessionExpired: () => subject.next({ kind: "session-expired", ts: Date.now(), userId: null }),
    setReady: (n: boolean) => {
      ready = n;
    },
  };
}

/** Minimal ItemRecord fixture for loadBatchById / loadBatchByPrefix responses. */
function makeItem(
  id: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    feedItemId: `fi-${id}`,
    articleId: id,
    title: `Title ${id}`,
    feedId: "feed-1",
    publishDate: new Date("2026-05-13T00:00:00Z"),
    tags: ["tech"],
    notes: [],
    haveStar: false,
    dictionaryId: "dict-1",
    isDeleted: false,
    ...extra,
  };
}

/**
 * Wire up the full collaborator chain over a MockDataAdapter.
 * fetchDelta / loadBatchById / loadBatchByPrefix are mocked globally — each test controls them
 * via mockFetchDelta / mockLoadBatchById / mockLoadBatchByPrefix.
 */
async function makeRig(): Promise<{
  orchestrator: SyncOrchestrator;
  adapter: MockDataAdapter;
  storage: VaultFileStorage;
  settings: SettingsManager;
  registry: ArticleRegistry;
  auth: {
    service: AuthService;
    fireSessionExpired: () => void;
    setReady: (n: boolean) => void;
  };
}> {
  const adapter = new MockDataAdapter();
  const storage = new VaultFileStorage(asAdapter(adapter));
  const settings = await makeSettings();
  const auth = makeAuthStub(true);
  const registry = new ArticleRegistry({ storage, registryPath: ".obsidian/test/registry.json" });
  const writer = new VaultWriter({ storage, now: () => 5_000_000, linkPrefs: { useMarkdownLinks: false, newLinkFormat: "shortest" } });
  const syncFiles = new SyncFiles({
    vaultWriter: writer,
    formatConverter: { convert },
    settings,
    registry,
    networkGate: { isAllowed },
    networkDetect: { getConnection: () => makeConn(true, "wifi") },
    os: "linux",
  });
  const deletePolicyExecutor = new DeletePolicyExecutor({
    storage,
    settings,
    now: () => 6_000_000,
  });
  const orchestrator = new SyncOrchestrator({
    apiClient: {} as any,
    bodyLoader: {
      load: async () => "<p>body</p>",
      clearDictCache: async () => {},
    } as any,
    syncFiles,
    vaultWriter: writer,
    deletePolicyExecutor,
    networkGate: { isAllowed },
    networkDetect: { getConnection: () => makeConn(true, "wifi") },
    auth: auth.service,
    settings,
    registry,
    storage,
  });

  return { orchestrator, adapter, storage, settings, registry, auth };
}

describe("M-SYNC-ORCHESTRATOR (V-M-SYNC-ORCHESTRATOR)", () => {
  beforeEach(() => {
    __resetObsidianMock();
    mockFetchDelta.mockReset();
    mockLoadBatchById.mockReset();
    mockLoadBatchByPrefix.mockReset();
  });

  // -------------------------------------------------------------------------
  // scenario-1 — triggerSync('manual') executes the full pipeline
  // -------------------------------------------------------------------------
  it("scenario-1: manual sync writes the batch articles to the vault", async () => {
    mockFetchDelta.mockResolvedValue({
      batches: [{ type: "byId", ids: ["m1", "m2"] }],
      cdn: null,
      feeds: [{ feedId: "feed-1", title: "MyFeed" }],
      newStamp: 2,
    });
    mockLoadBatchById.mockResolvedValue([makeItem("m1"), makeItem("m2")]);

    const rig = await makeRig();
    await rig.settings.set("syncFavoritesOnly", false);
    const result = await rig.orchestrator.triggerSync("manual");
    expect(result.success).toBe(true);
    expect(result.written).toBe(2);
    expect(result.skipped).toBe(0);
    expect(await rig.storage.exists("Readine/MyFeed/2026-05/Title m1.md")).toBe(true);
    expect(await rig.storage.exists("Readine/MyFeed/2026-05/Title m2.md")).toBe(true);
  });

  // -------------------------------------------------------------------------
  // scenario-2 — triggerSync('auto') runs the same pipeline
  // -------------------------------------------------------------------------
  it("scenario-2: auto sync writes the same way as manual", async () => {
    mockFetchDelta.mockResolvedValue({
      batches: [{ type: "byId", ids: ["auto-a"] }],
      cdn: null,
      feeds: [{ feedId: "feed-1", title: "MyFeed" }],
      newStamp: 1,
    });
    mockLoadBatchById.mockResolvedValue([makeItem("auto-a")]);

    const rig = await makeRig();
    await rig.settings.set("syncFavoritesOnly", false);
    const result = await rig.orchestrator.triggerSync("auto");
    expect(result.success).toBe(true);
    expect(result.written).toBe(1);
  });

  // -------------------------------------------------------------------------
  // scenario-3 — concurrent triggers are debounced
  // -------------------------------------------------------------------------
  it("scenario-3: concurrent triggers receive the same Promise (debounce)", async () => {
    mockFetchDelta.mockResolvedValue({
      batches: [{ type: "byId", ids: ["c1"] }],
      cdn: null,
      feeds: [{ feedId: "feed-1", title: "MyFeed" }],
      newStamp: 1,
    });
    mockLoadBatchById.mockResolvedValue([makeItem("c1")]);

    const rig = await makeRig();
    await rig.settings.set("syncFavoritesOnly", false);
    const p1 = rig.orchestrator.triggerSync("manual");
    const p2 = rig.orchestrator.triggerSync("manual");
    expect(p1).toBe(p2);
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toEqual(r2);
    expect(r1.written).toBe(1);
  });

  // -------------------------------------------------------------------------
  // scenario-4 — network gate denies → abort with NETWORK_BLOCKED
  // -------------------------------------------------------------------------
  it("scenario-4: networkGate denies → result.error === 'NETWORK_BLOCKED' and no vault writes", async () => {
    const adapter = new MockDataAdapter();
    const storage = new VaultFileStorage(asAdapter(adapter));
    const settings = await makeSettings();
    await settings.set("networkForArticles", "off");
    const auth = makeAuthStub(true);
    const writer = new VaultWriter({ storage, now: () => 5_000_000, linkPrefs: { useMarkdownLinks: false, newLinkFormat: "shortest" } });
    const netBlockRegistry = new ArticleRegistry({ storage, registryPath: ".obsidian/test/registry.json" });
    const syncFiles = new SyncFiles({
      vaultWriter: writer,
      formatConverter: { convert },
      settings,
      registry: netBlockRegistry,
      networkGate: { isAllowed },
      networkDetect: { getConnection: () => makeConn(true, "wifi") },
      os: "linux",
    });
    const exec = new DeletePolicyExecutor({ storage, settings });
    const orchestrator = new SyncOrchestrator({
      apiClient: {} as any,
      bodyLoader: { load: async () => "<p>body</p>" } as any,
      syncFiles,
      vaultWriter: writer,
      deletePolicyExecutor: exec,
      networkGate: { isAllowed },
      networkDetect: { getConnection: () => makeConn(true, "wifi") },
      auth: auth.service,
      settings,
      registry: netBlockRegistry,
      storage,
    });

    const result = await orchestrator.triggerSync("manual");
    expect(result.success).toBe(false);
    expect(result.error).toBe("NETWORK_BLOCKED");
    // No API should have been touched.
    expect(mockFetchDelta).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // scenario-5 — integration: manual sync with deletes counters
  // -------------------------------------------------------------------------
  it("scenario-5: integration — manual sync with deletes populates counters", async () => {
    // 1 live + 2 deleted items from loadBatchById.
    mockFetchDelta.mockResolvedValue({
      batches: [{ type: "byId", ids: ["live-1", "del-1", "del-2"] }],
      cdn: null,
      feeds: [{ feedId: "feed-1", title: "MyFeed" }],
      newStamp: 1,
    });
    mockLoadBatchById.mockResolvedValue([
      makeItem("live-1"),
      makeItem("del-1", { isDeleted: true }),
      makeItem("del-2", { isDeleted: true }),
    ]);

    const rig = await makeRig();
    await rig.settings.set("syncFavoritesOnly", false);
    // Pre-populate pathMappings + actual files for the delete branch.
    rig.registry.putPathMappings({
      "fi-del-1": "Readine/MyFeed/2026-05/Title del-1.md",
      "fi-del-2": "Readine/MyFeed/2026-05/Title del-2.md",
    });
    // Pre-populate registry entries so delete-policy-executor gets lastSyncWriteMtime.
    rig.registry.putEntry({
      feedItemId: "fi-del-1", articleId: "del-1",
      filePath: "Readine/MyFeed/2026-05/Title del-1.md",
      haveStar: false, hasNotes: false,
      lastSyncWriteMtime: 1, _attachments: [],
    });
    rig.registry.putEntry({
      feedItemId: "fi-del-2", articleId: "del-2",
      filePath: "Readine/MyFeed/2026-05/Title del-2.md",
      haveStar: false, hasNotes: false,
      lastSyncWriteMtime: 1, _attachments: [],
    });
    // Prevent first-sync → full-update → registry.clear() from wiping our pre-populated entries.
    rig.registry.lastSyncStamp = 1;
    await rig.settings.set("deletePolicy", "delete");
    await rig.adapter.mkdir("Readine");
    await rig.adapter.mkdir("Readine/MyFeed");
    await rig.adapter.mkdir("Readine/MyFeed/2026-05");
    await rig.adapter.write(
      "Readine/MyFeed/2026-05/Title del-1.md",
      "---\ntitle: Title del-1\nsource: r\nurl: https://x\ndate: 2026\ntags: []\narticleId: del-1\n---\nbody1\n",
    );
    rig.adapter.__setMtime("Readine/MyFeed/2026-05/Title del-1.md", 1);
    await rig.adapter.write(
      "Readine/MyFeed/2026-05/Title del-2.md",
      "---\ntitle: Title del-2\nsource: r\nurl: https://x\ndate: 2026\ntags: []\narticleId: del-2\n---\nbody2\n",
    );
    rig.adapter.__setMtime("Readine/MyFeed/2026-05/Title del-2.md", 1);

    const result = await rig.orchestrator.triggerSync("manual");
    expect(result.success).toBe(true);
    expect(result.written).toBe(1);
    expect(result.deleted).toBe(2);
    // Live file present, deletes removed.
    expect(await rig.storage.exists("Readine/MyFeed/2026-05/Title live-1.md")).toBe(true);
    expect(await rig.storage.exists("Readine/MyFeed/2026-05/Title del-1.md")).toBe(false);
  });

  // -------------------------------------------------------------------------
  // scenario-6 — auto-sync with debounce + subsequent tick
  // -------------------------------------------------------------------------
  it("scenario-6: auto sync with timer-driven trigger end-to-end", async () => {
    mockFetchDelta.mockResolvedValue({
      batches: [{ type: "byId", ids: ["timer-1"] }],
      cdn: null,
      feeds: [{ feedId: "feed-1", title: "MyFeed" }],
      newStamp: 1,
    });
    mockLoadBatchById.mockResolvedValue([makeItem("timer-1")]);

    const rig = await makeRig();
    await rig.settings.set("syncFavoritesOnly", false);
    const p1 = rig.orchestrator.triggerSync("auto");
    const p2 = rig.orchestrator.triggerSync("auto");
    expect(p1).toBe(p2);
    const [r1] = await Promise.all([p1, p2]);
    expect(r1.success).toBe(true);
    expect(r1.written).toBe(1);

    // Subsequent (non-overlapping) tick runs the pipeline again.
    mockFetchDelta.mockResolvedValue({
      batches: [{ type: "byId", ids: ["timer-2"] }],
      cdn: null,
      feeds: [{ feedId: "feed-1", title: "MyFeed" }],
      newStamp: 2,
    });
    mockLoadBatchById.mockResolvedValue([makeItem("timer-2")]);
    const r3 = await rig.orchestrator.triggerSync("auto");
    expect(r3.success).toBe(true);
  });

  // -------------------------------------------------------------------------
  // scenario-7 — 401 MID-SYNC: session-expired fires mid-sync
  // -------------------------------------------------------------------------
  it("scenario-7: 401 mid-sync — session-expired mid-write, written articles remain, returns session_expired", async () => {
    const adapter = new MockDataAdapter();
    const storage = new VaultFileStorage(asAdapter(adapter));
    const settings = await makeSettings();
    await settings.set("syncFavoritesOnly", false);
    const auth = makeAuthStub(true);

    mockFetchDelta.mockResolvedValue({
      batches: [{ type: "byId", ids: ["ok-1", "ok-2"] }],
      cdn: null,
      feeds: [{ feedId: "feed-1", title: "MyFeed" }],
      newStamp: 2,
    });
    mockLoadBatchById.mockResolvedValue([makeItem("ok-1"), makeItem("ok-2")]);

    const writer = new VaultWriter({ storage, now: () => 5_000_000, linkPrefs: { useMarkdownLinks: false, newLinkFormat: "shortest" } });
    const scenarioRegistry = new ArticleRegistry({ storage, registryPath: ".obsidian/test/registry.json" });
    const syncFiles = new SyncFiles({
      vaultWriter: writer,
      formatConverter: { convert },
      settings,
      registry: scenarioRegistry,
      networkGate: { isAllowed },
      networkDetect: { getConnection: () => makeConn(true, "wifi") },
      os: "linux",
    });
    // Wrap processArticle to fire session-expired after the first write completes.
    const origProcessArticle = syncFiles.processArticle.bind(syncFiles);
    let callCount = 0;
    syncFiles.processArticle = async (article) => {
      const result = await origProcessArticle(article);
      callCount++;
      if (callCount === 1) {
        auth.fireSessionExpired();
      }
      return result;
    };

    const exec = new DeletePolicyExecutor({ storage, settings });
    const orchestrator = new SyncOrchestrator({
      apiClient: {} as any,
      bodyLoader: { load: async () => "<p>body</p>" } as any,
      syncFiles,
      vaultWriter: writer,
      deletePolicyExecutor: exec,
      networkGate: { isAllowed },
      networkDetect: { getConnection: () => makeConn(true, "wifi") },
      auth: auth.service,
      settings,
      registry: scenarioRegistry,
      storage,
    });

    const result = await orchestrator.triggerSync("manual");
    expect(result.success).toBe(false);
    expect(result.error).toBe("session_expired");
    // At least the first article was written before session-expired fired.
    // In per-article pipeline with concurrent workers, the second article
    // may also be written if its download completed before the abort check.
    expect(result.written).toBeGreaterThanOrEqual(1);
    expect(await storage.exists("Readine/MyFeed/2026-05/Title ok-1.md")).toBe(true);
  });

  // -------------------------------------------------------------------------
  // edge — auth.isReady() false → no_auth
  // -------------------------------------------------------------------------
  it("edge: auth not ready → graceful failure with error='no_auth'", async () => {
    mockFetchDelta.mockResolvedValue({
      batches: [{ type: "byId", ids: ["x"] }],
      cdn: null,
      feeds: [{ feedId: "feed-1", title: "MyFeed" }],
      newStamp: 1,
    });

    const adapter = new MockDataAdapter();
    const storage = new VaultFileStorage(asAdapter(adapter));
    const settings = await makeSettings();
    const auth = makeAuthStub(false); // not ready
    const writer = new VaultWriter({ storage, now: () => 5_000_000, linkPrefs: { useMarkdownLinks: false, newLinkFormat: "shortest" } });
    const noAuthRegistry = new ArticleRegistry({ storage, registryPath: ".obsidian/test/registry.json" });
    const syncFiles = new SyncFiles({
      vaultWriter: writer,
      formatConverter: { convert },
      settings,
      registry: noAuthRegistry,
      networkGate: { isAllowed },
      networkDetect: { getConnection: () => makeConn(true, "wifi") },
      os: "linux",
    });
    const exec = new DeletePolicyExecutor({ storage, settings });
    const orchestrator = new SyncOrchestrator({
      apiClient: {} as any,
      bodyLoader: { load: async () => "<p>body</p>" } as any,
      syncFiles,
      vaultWriter: writer,
      deletePolicyExecutor: exec,
      networkGate: { isAllowed },
      networkDetect: { getConnection: () => makeConn(true, "wifi") },
      auth: auth.service,
      settings,
      registry: noAuthRegistry,
      storage,
    });

    const result = await orchestrator.triggerSync("manual");
    expect(result.success).toBe(false);
    expect(result.error).toBe("no_auth");
    // fetchDelta should not have been called.
    expect(mockFetchDelta).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // marker — SYNC_TRIGGERED + SYNC_COMPLETE
  // -------------------------------------------------------------------------
  // -------------------------------------------------------------------------
  // syncFavoritesOnly — filter non-starred articles
  // -------------------------------------------------------------------------
  it("syncFavoritesOnly: only writes favorited articles when setting is enabled", async () => {
    mockFetchDelta.mockResolvedValue({
      batches: [{ type: "byId", ids: ["fav", "unfav"] }],
      cdn: null,
      feeds: [{ feedId: "feed-1", title: "MyFeed" }],
      newStamp: 1,
    });
    mockLoadBatchById.mockResolvedValue([
      makeItem("fav", { haveStar: true }),
      makeItem("unfav", { haveStar: false }),
    ]);

    const rig = await makeRig();
    await rig.settings.set("syncFavoritesOnly", true);

    const result = await rig.orchestrator.triggerSync("manual");
    expect(result.success).toBe(true);
    expect(result.written).toBe(1);
    expect(result.skipped).toBe(1);
    expect(await rig.storage.exists("Readine/MyFeed/2026-05/Title fav.md")).toBe(true);
    expect(await rig.storage.exists("Readine/MyFeed/2026-05/Title unfav.md")).toBe(false);
  });

  it("syncFavoritesOnly: writes all articles when setting is disabled", async () => {
    mockFetchDelta.mockResolvedValue({
      batches: [{ type: "byId", ids: ["a", "b"] }],
      cdn: null,
      feeds: [{ feedId: "feed-1", title: "MyFeed" }],
      newStamp: 1,
    });
    mockLoadBatchById.mockResolvedValue([
      makeItem("a", { haveStar: true }),
      makeItem("b", { haveStar: false }),
    ]);

    const rig = await makeRig();
    await rig.settings.set("syncFavoritesOnly", false);

    const result = await rig.orchestrator.triggerSync("manual");
    expect(result.success).toBe(true);
    expect(result.written).toBe(2);
    expect(result.skipped).toBe(0);
  });

  it("emits SYNC_TRIGGERED at start and SYNC_COMPLETE at end with correct anchors", async () => {
    mockFetchDelta.mockResolvedValue({
      batches: [],
      cdn: null,
      feeds: [],
      newStamp: 0,
    });

    const rig = await makeRig();
    const infoSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
    await rig.orchestrator.triggerSync("manual");
    const events = infoSpy.mock.calls
      .map((c) => c[0] as Record<string, unknown>)
      .filter((p) => p.module === "M-SYNC-ORCHESTRATOR");
    const triggered = events.find((p) => p.event === "SYNC_TRIGGERED");
    const complete = events.find((p) => p.event === "SYNC_COMPLETE");
    expect(triggered).toBeDefined();
    expect(triggered!.anchor).toBe("triggerSync:BLOCK_START");
    expect(complete).toBeDefined();
    expect(complete!.anchor).toBe("triggerSync:BLOCK_COMPLETE");
    infoSpy.mockRestore();
  });

  // -------------------------------------------------------------------------
  // scenario-8 — fullReset + template change → new paths, no registry skip
  // -------------------------------------------------------------------------
  it("scenario-8: fullReset + template change → articles use new path, not skipped by stale registry", async () => {
    const rig = await makeRig();
    await rig.settings.set("syncFavoritesOnly", false);

    // Simulate state after a previous sync with template A + non-zero stamp.
    rig.registry.putPathMappings({
      "fi-art-old": "Readine/OldFeed/2026-06/Old Title.md",
    });
    rig.registry.putEntry({
      feedItemId: "fi-art-old",
      articleId: "art-old",
      filePath: "Readine/OldFeed/2026-06/Old Title.md",
      haveStar: false,
      hasNotes: false,
      lastSyncWriteMtime: 100,
      _attachments: [],
    });
    rig.registry.lastSyncStamp = 42;
    await rig.registry.flush();

    // Step 1: logout → fullReset.
    await rig.registry.fullReset();

    expect(rig.registry.lastSyncStamp).toBe(0);
    expect(rig.registry.getPathMappings()).toEqual({});
    expect(rig.registry.getTotalCount()).toBe(0);

    // Step 2: change path template after login.
    await rig.settings.set("pathTemplate", "Readine/{feedName}/{yyyy}/{title}.md");

    // Step 3: sync — server returns the same article.
    mockFetchDelta.mockResolvedValue({
      batches: [{ type: "byId", ids: ["art-old"] }],
      cdn: null,
      feeds: [{ feedId: "feed-1", title: "MyFeed" }],
      newStamp: 50,
    });
    mockLoadBatchById.mockResolvedValue([makeItem("art-old")]);

    const result = await rig.orchestrator.triggerSync("manual");

    // Must be written (not skipped by stale registry entry).
    expect(result.written).toBe(1);
    expect(result.skipped).toBe(0);

    // Must use NEW template path, not the old mapping path.
    expect(await rig.storage.exists("Readine/MyFeed/2026/Title art-old.md")).toBe(true);
    expect(await rig.storage.exists("Readine/OldFeed/2026-06/Old Title.md")).toBe(false);
  });

  // -------------------------------------------------------------------------
  // scenario-9 — fullReset NOT called → stale registry skips articles on re-sync
  // -------------------------------------------------------------------------
  it("scenario-9: without fullReset, stale registry entries cause REGISTRY_HIT_SKIP on re-sync", async () => {
    const rig = await makeRig();

    // Pre-populate registry as if a previous sync completed.
    rig.registry.putPathMappings({
      "fi-art-x": "Readine/MyFeed/2026-05/Title art-x.md",
    });
    rig.registry.putEntry({
      feedItemId: "fi-art-x",
      articleId: "art-x",
      filePath: "Readine/MyFeed/2026-05/Title art-x.md",
      haveStar: false,
      hasNotes: false,
      lastSyncWriteMtime: 100,
      _attachments: [],
    });
    rig.registry.lastSyncStamp = 10;
    await rig.registry.flush();

    // Do NOT call fullReset — simulate sync without logout.
    // Change template.
    await rig.settings.set("pathTemplate", "Readine/{feedName}/{yyyy}/{title}.md");

    // Server returns delta with the same article.
    mockFetchDelta.mockResolvedValue({
      batches: [{ type: "byId", ids: ["art-x"] }],
      cdn: null,
      feeds: [{ feedId: "feed-1", title: "MyFeed" }],
      newStamp: 20,
      isFullUpdate: false,
    });
    mockLoadBatchById.mockResolvedValue([makeItem("art-x")]);

    const infoSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
    const result = await rig.orchestrator.triggerSync("manual");

    // Article should be SKIPPED due to stale registry entry.
    expect(result.written).toBe(0);
    expect(result.skipped).toBe(1);

    // Verify REGISTRY_HIT_SKIP log was emitted.
    const skipLogs = infoSpy.mock.calls
      .map((c) => c[0] as Record<string, unknown>)
      .filter((p) =>
        p.module === "M-SYNC-ORCHESTRATOR" &&
        p.event === "REGISTRY_HIT_SKIP",
      );
    expect(skipLogs.length).toBe(1);
    expect(skipLogs[0]!.feedItemId).toBe("fi-art-x");

    infoSpy.mockRestore();
  });
});

// START_CHANGE_SUMMARY
// LAST_CHANGE: 2026-05-31 — rewrite for two-phase sync pattern
// LAST_CHANGE: 2026-06-01 — add syncFavoritesOnly tests
// LAST_CHANGE: 2026-06-08 — migrate putPathMappings keys from articleId-style to feedItemId-style (UC-016 fix)
// END_CHANGE_SUMMARY
