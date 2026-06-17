// START_MODULE_CONTRACT
// PURPOSE: Tests for M-ARTICLE-REGISTRY — upsert, load, total count
// SCOPE: src/sync/article-registry.test.ts
// DEPENDS: M-ARTICLE-REGISTRY
// LINKS: V-M-ARTICLE-REGISTRY
// ROLE: TEST
// END_MODULE_CONTRACT

// START_MODULE_MAP
// (test file — no public exports)
// END_MODULE_MAP

import { beforeEach, describe, expect, it, vi } from "vitest";
import { ArticleRegistry } from "./article-registry";
import { FeedRecord } from "../api/clientV1_0";
import type { CdnStrategyLike } from "./cdn-resolver";

vi.mock("obsidian", () => import("../__mocks__/obsidian"));

function makeStorage() {
  const files = new Map<string, string>();
  return {
    storage: {
      exists: vi.fn(async (path: string) => files.has(path)),
      read: vi.fn(async (path: string) => files.get(path) ?? ""),
      write: vi.fn(async (path: string, data: string) => { files.set(path, data); }),
      remove: vi.fn(async (path: string) => { files.delete(path); }),
    },
    files,
  };
}

function makeRegistry(storage: ReturnType<typeof makeStorage>["storage"]) {
  return new ArticleRegistry({ storage: storage as any, registryPath: ".obsidian/test/registry.json" });
}

async function seedRegistry(
  storage: ReturnType<typeof makeStorage>["storage"],
  registryPath: string,
  data: object,
): Promise<void> {
  await storage.write(registryPath, JSON.stringify(data));
}

describe("M-ARTICLE-REGISTRY (V-M-ARTICLE-REGISTRY)", () => {
  let storage: ReturnType<typeof makeStorage>["storage"];
  let files: ReturnType<typeof makeStorage>["files"];
  let registry: ArticleRegistry;

  beforeEach(() => {
    const s = makeStorage();
    storage = s.storage;
    files = s.files;
    registry = makeRegistry(storage);
  });

  describe("upsert and lookup", () => {
    it("stores article entry via putEntry", () => {
      registry.putEntry({
        feedItemId: "fi-1",
        articleId: "art-1",
        filePath: "Readine/MyFeed/article.md",
        haveStar: false,
        hasNotes: false,
        lastSyncWriteMtime: 100,
        _attachments: [],
      });
      const entry = registry.get("fi-1");
      expect(entry).not.toBeNull();
      expect(entry!.articleId).toBe("art-1");
    });

    it("getTotalCount returns total entries", () => {
      registry.putEntry({
        feedItemId: "fi-1",
        articleId: "art-1",
        filePath: "Readine/MyFeed/a.md",
        haveStar: false, hasNotes: false,
        lastSyncWriteMtime: 100, _attachments: [],
      });
      registry.putEntry({
        feedItemId: "fi-2",
        articleId: "art-2",
        filePath: "Readine/MyFeed/b.md",
        haveStar: false, hasNotes: false,
        lastSyncWriteMtime: 100, _attachments: [],
      });
      expect(registry.getTotalCount()).toBe(2);
    });

    it("load restores entries from JSON", async () => {
      const raw = JSON.stringify({
        lastSyncStamp: 42,
        entries: {
          "fi-old": {
            feedItemId: "fi-old",
            articleId: "art-old",
            filePath: "Readine/Old/article.md",
            haveStar: false,
            hasNotes: false,
            lastSyncWriteMtime: 50,
            _attachments: [],
          },
        },
      });
      await seedRegistry(storage, ".obsidian/test/registry.json", JSON.parse(raw));
      const reg = makeRegistry(storage);
      await reg.load();
      expect(reg.getTotalCount()).toBe(1);
    });
  });

  describe("fullReset", () => {
    it("clears all in-memory state: entries, pathMappings, stamp, feeds, cdn", async () => {
      registry.putEntry({
        feedItemId: "fi-1",
        articleId: "art-1",
        filePath: "Readine/Feed/article.md",
        haveStar: false, hasNotes: false,
        lastSyncWriteMtime: 100, _attachments: [],
      });
      registry.putPathMappings({ "feed-1": "Readine/Feed/article.md" });
      registry.lastSyncStamp = 42;
      registry.cdnConfig = {} as CdnStrategyLike;
      registry.feeds = [new FeedRecord({ feedId: "f1", folderId: "", title: "F1", source: "" })];

      await registry.fullReset();

      expect(registry.lastSyncStamp).toBe(0);
      expect(registry.getTotalCount()).toBe(0);
      expect(registry.getPathMappings()).toEqual({});
      expect(registry.cdnConfig).toBeNull();
      expect(registry.feeds).toEqual([]);
    });

    it("writes empty registry to disk", async () => {
      await seedRegistry(storage, ".obsidian/test/registry.json", {
        lastSyncStamp: 42,
        entries: { "fi-1": { feedItemId: "fi-1", articleId: "art-1", filePath: "p.md", haveStar: false, hasNotes: false, lastSyncWriteMtime: 1, _attachments: [] } },
        pathMappings: { "feed-1": "p.md" },
        feeds: [{ feedId: "f1" }],
        cdnConfig: { v: 1 },
      });
      const reg = makeRegistry(storage);
      await reg.load();
      expect(reg.lastSyncStamp).toBe(42);

      await reg.fullReset();

      const reg2 = makeRegistry(storage);
      await reg2.load();
      expect(reg2.lastSyncStamp).toBe(0);
      expect(reg2.getTotalCount()).toBe(0);
      expect(reg2.getPathMappings()).toEqual({});
    });

    it("clearPending does not log warnings when pending file is absent", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      registry.putEntry({
        feedItemId: "fi-1", articleId: "art-1",
        filePath: "Readine/a.md",
        haveStar: false, hasNotes: false,
        lastSyncWriteMtime: 100, _attachments: [],
      });
      registry.lastSyncStamp = 42;
      registry.putPathMappings({ "feed-1": "Readine/a.md" });

      await registry.fullReset();

      const vaultWarns = warnSpy.mock.calls
        .filter((c) => {
          const m = c[0] as Record<string, unknown>;
          return m?.module === "M-VAULT-FILE-STORAGE";
        });
      expect(vaultWarns.length).toBe(0);
      warnSpy.mockRestore();
    });
  });
});

// START_CHANGE_SUMMARY
// LAST_CHANGE: 2026-06-08 — migrate pathMappings keys from articleId-style to feedItemId-style in test data (UC-016 fix)
// END_CHANGE_SUMMARY
