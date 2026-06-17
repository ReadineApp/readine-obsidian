import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => import("../__mocks__/obsidian"));

import { MockDataAdapter, __resetObsidianMock } from "../__mocks__/obsidian";
import type { DataAdapter } from "obsidian";
import { VaultFileStorage } from "../storage/vault-file-storage";
import type { IFileStorage } from "../storage/vault-file-storage";
import { CacheCleanup } from "./cache-cleanup";
import type { ArticleRegistry } from "./article-registry";
import type { SettingsManager } from "../settings/settings-manager";

const NOW = 100_000_000_000;

function asAdapter(a: MockDataAdapter): DataAdapter {
  return a as unknown as DataAdapter;
}

function makeSettings(overrides: Partial<Record<string, unknown>> = {}) {
  const defaults = {
    limitCacheDays: 30,
    cleanupExcludeFavorites: false,
    cleanupExcludeWithNotes: false,
    pathTemplate: "Readine/{feedName}/{title}.md",
  };
  return {
    getAll: () => ({ ...defaults, ...overrides }),
  } as SettingsManager;
}

function makeRegistry(
  overrides: {
    findByFilePath?: Record<string, unknown> | null;
    isProtectedByPath?: { protected: boolean; reason?: string };
  } = {},
) {
  return {
    findByFilePath: vi.fn().mockReturnValue(
      overrides.findByFilePath ?? null,
    ),
    isProtectedByPath: vi.fn().mockReturnValue(
      overrides.isProtectedByPath ?? { protected: false },
    ),
  } as unknown as ArticleRegistry;
}

describe("M-CACHE-CLEANUP (V-M-CACHE-CLEANUP)", () => {
  let adapter: MockDataAdapter;
  let storage: IFileStorage;

  beforeEach(() => {
    __resetObsidianMock();
    adapter = new MockDataAdapter();
    storage = new VaultFileStorage(asAdapter(adapter));
  });

  async function writeFile(
    path: string,
    content: string,
    mtime?: number,
  ): Promise<void> {
    await storage.write(path, content);
    if (mtime !== undefined) adapter.__setMtime(path, mtime);
  }

  it("deletes files older than limitCacheDays", async () => {
    await writeFile("Readine/old.md", "old content", 1000);
    const settings = makeSettings({ limitCacheDays: 30 });
    const registry = makeRegistry();

    const cleanup = new CacheCleanup({
      storage,
      settings,
      registry,
      now: () => NOW,
    });

    const result = await cleanup.scan();
    expect(result.deleted).toBe(1);
    expect(result.scanned).toBe(1);
    expect(result.protected).toBe(0);

    const exists = await storage.exists("Readine/old.md");
    expect(exists).toBe(false);
  });

  it("skips favorited files when cleanupExcludeFavorites=true", async () => {
    await writeFile("Readine/fav.md", "favorited", 1000);
    const settings = makeSettings({
      limitCacheDays: 30,
      cleanupExcludeFavorites: true,
    });
    const registry = makeRegistry({
      findByFilePath: {
        feedItemId: "fi-fav",
        articleId: "art-fav",
        filePath: "Readine/fav.md",
        haveStar: true,
        hasNotes: false,
        lastSyncWriteMtime: 0,
        _attachments: [],
      },
    });

    const cleanup = new CacheCleanup({
      storage,
      settings,
      registry,
      now: () => NOW,
    });

    const result = await cleanup.scan();
    expect(result.deleted).toBe(0);
    expect(result.protected).toBe(1);
    expect(registry.findByFilePath).toHaveBeenCalledWith("Readine/fav.md");

    const exists = await storage.exists("Readine/fav.md");
    expect(exists).toBe(true);
  });

  it("skips files with notes when cleanupExcludeWithNotes=true", async () => {
    await writeFile("Readine/notes.md", "has notes", 1000);
    const settings = makeSettings({
      limitCacheDays: 30,
      cleanupExcludeWithNotes: true,
    });
    const registry = makeRegistry({
      findByFilePath: {
        feedItemId: "fi-notes",
        articleId: "art-notes",
        filePath: "Readine/notes.md",
        haveStar: false,
        hasNotes: true,
        lastSyncWriteMtime: 0,
        _attachments: [],
      },
    });

    const cleanup = new CacheCleanup({
      storage,
      settings,
      registry,
      now: () => NOW,
    });

    const result = await cleanup.scan();
    expect(result.deleted).toBe(0);
    expect(result.protected).toBe(1);
  });

  it("returns empty result when no files exist", async () => {
    const settings = makeSettings({ limitCacheDays: 30 });
    const registry = makeRegistry();

    const cleanup = new CacheCleanup({
      storage,
      settings,
      registry,
      now: () => NOW,
    });

    const result = await cleanup.scan();
    expect(result.deleted).toBe(0);
    expect(result.scanned).toBe(0);
    expect(result.protected).toBe(0);
  });

  it("protects files with local edits via mtime-guard (isProtectedByPath)", async () => {
    await writeFile("Readine/edited.md", "edited locally", 1000);
    const settings = makeSettings({ limitCacheDays: 30 });
    const registry = makeRegistry({
      findByFilePath: null,
      isProtectedByPath: { protected: true, reason: "local_edits" },
    });

    const cleanup = new CacheCleanup({
      storage,
      settings,
      registry,
      now: () => NOW,
    });

    const result = await cleanup.scan();
    expect(result.deleted).toBe(0);
    expect(result.protected).toBe(1);
    expect(registry.isProtectedByPath).toHaveBeenCalled();

    const exists = await storage.exists("Readine/edited.md");
    expect(exists).toBe(true);
  });
});
