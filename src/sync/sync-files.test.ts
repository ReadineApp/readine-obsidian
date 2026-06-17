// START_MODULE_CONTRACT
// PURPOSE: Critical-tier tests for M-SYNC-FILES — gate denial path, full convert+write+guard+conflict cycle for one article, batch of 10 with one local-edit skip.
// SCOPE: src/sync/sync-files.test.ts
// DEPENDS: M-SYNC-FILES, M-VAULT-WRITER, M-NETWORK-GATE, M-SETTINGS-MANAGER
// LINKS: V-M-SYNC-FILES
// ROLE: TEST
// END_MODULE_CONTRACT

// START_MODULE_MAP
// (test file — no public exports)
// END_MODULE_MAP

import { beforeEach, describe, expect, it, vi } from "vitest";

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

import { SyncFiles } from "./sync-files";
import type { Article } from "./types";
import type { ArticleRegistry } from "./article-registry";

function makeRegistry(): ArticleRegistry {
  const store: Record<string, string> = {};
  return {
    getPathMappings: () => ({ ...store }),
    putPathMappings: (delta: Record<string, string>) => { Object.assign(store, delta); },
    get: () => null,
    removePathMapping: () => {},
  } as unknown as ArticleRegistry;
}

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
  // Default getDefaults("desktop") sets networkForArticles='always',
  // outputFormat='markdown+frontmatter', pathTemplate='Readine/{feedName}/{yyyy}-{mm}/{title}.md'.
  return m;
}

function makeArticle(overrides: Partial<Article> = {}): Article {
  return {
    id: "art-aaaaaaaa11112222",
    feedItemId: "fi-art-aaaaaaaa11112222",
    title: "Hello",
    url: "https://example.com/a",
    date: "2026-05-13T00:00:00Z",
    tags: ["tech"],
    notes: [],
    bodyHtml: "<p>Hello <strong>world</strong>.</p>",
    feedName: "MyFeed",
    feedId: "feed-1",
    haveStar: false,
    ...overrides,
  };
}

function makeConn(online: boolean, type: Connection["type"]): Connection {
  return { type, online };
}

describe("M-SYNC-FILES (V-M-SYNC-FILES)", () => {
  let adapter: MockDataAdapter;
  let storage: VaultFileStorage;
  let writer: VaultWriter;

  beforeEach(() => {
    __resetObsidianMock();
    adapter = new MockDataAdapter();
    storage = new VaultFileStorage(asAdapter(adapter));
    writer = new VaultWriter({ storage, now: () => 5_000_000, linkPrefs: { useMarkdownLinks: false, newLinkFormat: "shortest" } });
  });

  // scenario-1: per-article pipeline composition
  it("scenario-1: composes gate → writer → vault for one article", async () => {
    const settings = await makeSettings();
    const sync = new SyncFiles({
      vaultWriter: writer,
      formatConverter: { convert },
      settings,
      registry: makeRegistry(),
      networkGate: { isAllowed },
      networkDetect: { getConnection: () => makeConn(true, "wifi") },
      os: "linux",
    });
    const article = makeArticle();
    const result = await sync.processArticle(article);
    expect(result.skipped).toBe(false);
    expect(result.finalPath).toMatch(/^Readine\/MyFeed\/2026-05\/Hello\.md$/);
    expect(await storage.exists(result.finalPath!)).toBe(true);
    const content = await storage.read(result.finalPath!);
    expect(content.startsWith("---\n")).toBe(true);
    expect(content).toMatch(/articleId: "?art-aaaaaaaa11112222"?/);
  });

  // scenario-2: network-gate denies → skip article
  it("scenario-2: denies network → skip without touching vault", async () => {
    const settings = await makeSettings();
    await settings.set("networkForArticles", "Wi-Fi-only");
    const sync = new SyncFiles({
      vaultWriter: writer,
      formatConverter: { convert },
      settings,
      registry: makeRegistry(),
      networkGate: { isAllowed },
      // Cellular while user demands Wi-Fi-only → denied.
      networkDetect: { getConnection: () => makeConn(true, "cellular") },
      os: "linux",
    });
    const article = makeArticle();
    const result = await sync.processArticle(article);
    expect(result.skipped).toBe(true);
    expect(result.reason).toBe("network_blocked");
    // No vault writes at all.
    expect(adapter.__snapshot()).toEqual({});
  });

  // scenario-3: integration — full convert→write→guard→conflict cycle for 1 article
  it("scenario-3: integration — convert+write+guard+conflict for 1 article", async () => {
    const settings = await makeSettings();
    await settings.set("pathTemplate", "{feedName}/{title}.md");
    const registry = makeRegistry();
    const sync = new SyncFiles({
      vaultWriter: writer,
      formatConverter: { convert },
      settings,
      registry,
      networkGate: { isAllowed },
      networkDetect: { getConnection: () => makeConn(true, "wifi") },
      os: "linux",
    });
    // First article — happy path.
    const a1 = makeArticle({ id: "id-aaaa1111", feedItemId: "fi-id-aaaa1111", title: "Same Title" });
    const r1 = await sync.processArticle(a1);
    expect(r1.skipped).toBe(false);
    expect(r1.finalPath).toBe("MyFeed/Same Title.md");

    // Second article — same intended path → conflict resolver applies suffix.
    const a2 = makeArticle({ id: "id-bbbb2222", feedItemId: "fi-id-bbbb2222", title: "Same Title" });
    const r2 = await sync.processArticle(a2);
    expect(r2.skipped).toBe(false);
    // M-CONFLICT-RESOLVER appends -{feedItemId.slice(0,8)} per UC-014;
    // slice(0,8) of "fi-id-bbbb2222" → "fi-id-bb" → final "...Same Title-fi-id-bb.md".
    expect(r2.finalPath).toBe("MyFeed/Same Title-fi-id-bb.md");

    // Mappings have been persisted via ArticleRegistry.
    const mappings = registry.getPathMappings();
    expect(Object.keys(mappings).length).toBeGreaterThan(0);
  });

  // scenario-4: integration — batch of 10 articles, 1 with local edit → 9 written, 1 skipped
  it("scenario-4: integration — batch of 10 with one local edit → 9 written, 1 skipped", async () => {
    const settings = await makeSettings();
    await settings.set("pathTemplate", "{feedName}/{title}.md");
    const sync = new SyncFiles({
      vaultWriter: writer,
      formatConverter: { convert },
      settings,
      registry: makeRegistry(),
      networkGate: { isAllowed },
      networkDetect: { getConnection: () => makeConn(true, "wifi") },
      os: "linux",
    });
    // First write to establish file for article #5.
    const articles: Article[] = Array.from({ length: 10 }, (_, i) =>
      makeArticle({
        id: `id-${String(i).padStart(8, "0")}`,
        feedItemId: `fi-${String(i).padStart(8, "0")}`,
        title: `Article ${i}`,
      }),
    );
    // Write article #5 first so we can simulate the user editing it.
    await sync.processArticle(articles[5]!);
    // Simulate the user editing the file in Obsidian: bump mtime past
    // lastSyncWriteMtime (which is 5_000_000 from the writer.now mock).
    const localPath = "MyFeed/Article 5.md";
    expect(await storage.exists(localPath)).toBe(true);
    adapter.__setMtime(localPath, 9_999_999_999);

    // Now process the whole batch — article #5 must be skipped.
    const results = await sync.processBatch(articles);
    expect(results).toHaveLength(10);
    const skipped = results.filter((r) => r.skipped);
    const written = results.filter((r) => !r.skipped);
    expect(skipped).toHaveLength(1);
    expect(written).toHaveLength(9);
    expect(skipped[0]!.reason).toBe("local edits detected");
  });

  it("emits WRITE_PROCEED log marker on gate clear", async () => {
    const settings = await makeSettings();
    const sync = new SyncFiles({
      vaultWriter: writer,
      formatConverter: { convert },
      settings,
      registry: makeRegistry(),
      networkGate: { isAllowed },
      networkDetect: { getConnection: () => makeConn(true, "wifi") },
      os: "linux",
    });
    const spy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    await sync.processArticle(makeArticle());
    const payloads = spy.mock.calls.map(
      (c) => c[0] as Record<string, unknown>,
    );
    const proceed = payloads.find(
      (p) =>
        p.module === "M-SYNC-FILES" &&
        p.event === "WRITE_PROCEED" &&
        p.anchor === "processArticle:BLOCK_GATE_CHECK",
    );
    expect(proceed).toBeDefined();
    spy.mockRestore();
  });

  it("emits WRITE_BLOCKED log marker on gate denial", async () => {
    const settings = await makeSettings();
    await settings.set("networkForArticles", "off");
    const sync = new SyncFiles({
      vaultWriter: writer,
      formatConverter: { convert },
      settings,
      registry: makeRegistry(),
      networkGate: { isAllowed },
      networkDetect: { getConnection: () => makeConn(true, "wifi") },
      os: "linux",
    });
    const spy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    await sync.processArticle(makeArticle());
    const payloads = spy.mock.calls.map(
      (c) => c[0] as Record<string, unknown>,
    );
    const blocked = payloads.find(
      (p) => p.module === "M-SYNC-FILES" && p.event === "WRITE_BLOCKED",
    );
    expect(blocked).toBeDefined();
    spy.mockRestore();
  });

  it("processBatch returns results in input order", async () => {
    const settings = await makeSettings();
    await settings.set("pathTemplate", "{feedName}/{title}.md");
    const sync = new SyncFiles({
      vaultWriter: writer,
      formatConverter: { convert },
      settings,
      registry: makeRegistry(),
      networkGate: { isAllowed },
      networkDetect: { getConnection: () => makeConn(true, "wifi") },
      os: "linux",
    });
    const articles: Article[] = Array.from({ length: 3 }, (_, i) =>
      makeArticle({
        id: `id-${String(i).padStart(8, "0")}`,
        title: `Order ${i}`,
      }),
    );
    const results = await sync.processBatch(articles);
    expect(results[0]!.finalPath).toMatch(/Order 0\.md$/);
    expect(results[1]!.finalPath).toMatch(/Order 1\.md$/);
    expect(results[2]!.finalPath).toMatch(/Order 2\.md$/);
  });
});

// START_CHANGE_SUMMARY
// LAST_CHANGE: 2026-05-13 — initial test suite for V-M-SYNC-FILES
// LAST_CHANGE: 2026-06-08 — set unique feedItemId per test article for collision detection with feedItemId-keyed pathMappings (UC-016 fix)
// END_CHANGE_SUMMARY
