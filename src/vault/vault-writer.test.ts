// START_MODULE_CONTRACT
// PURPOSE: Integration tests for M-VAULT-WRITER — composition of guard + resolver + format + write; happy/skip paths.
// SCOPE: src/vault/vault-writer.test.ts
// DEPENDS: M-VAULT-WRITER
// LINKS: V-M-VAULT-WRITER
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
import {
  VaultWriter,
  type ReadineArticle,
  type WriterSettings,
} from "./vault-writer";

function asAdapter(a: MockDataAdapter): DataAdapter {
  return a as unknown as DataAdapter;
}

function makeArticle(overrides: Partial<ReadineArticle> = {}): ReadineArticle {
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

function makeSettings(
  overrides: Partial<WriterSettings> = {},
  store: { mappings: Record<string, string> } = { mappings: {} },
): { settings: WriterSettings; store: { mappings: Record<string, string> } } {
  const settings: WriterSettings = {
    pathTemplate: "{feedName}/{title}.md",
    outputFormat: "markdown",
    os: "linux",
    pathMappings: store.mappings,
    persistMappings: async (delta) => {
      store.mappings = { ...store.mappings, ...delta };
    },
    ...overrides,
  };
  return { settings, store };
}

describe("M-VAULT-WRITER (V-M-VAULT-WRITER)", () => {
  let adapter: MockDataAdapter;
  let storage: VaultFileStorage;
  let writer: VaultWriter;

  beforeEach(() => {
    __resetObsidianMock();
    adapter = new MockDataAdapter();
    storage = new VaultFileStorage(asAdapter(adapter));
    writer = new VaultWriter({ storage, now: () => 5_000_000, linkPrefs: { useMarkdownLinks: false, newLinkFormat: "shortest" } });
  });

  // scenario-1: writeArticle composes guard + resolver + format + write
  it("scenario-1: composes guard + resolver + format + write", async () => {
    const { settings } = makeSettings();
    const article = makeArticle();
    const result = await writer.writeArticle(
      article,
      "markdown",
      settings,
    );

    expect(result.skipped).toBe(false);
    expect(result.finalPath).toBe("MyFeed/Hello.md");
    expect(await storage.exists("MyFeed/Hello.md")).toBe(true);

    const content = await storage.read("MyFeed/Hello.md");
    expect(content.startsWith("---\n")).toBe(true);
    // articleId may be YAML-quoted by frontmatter-codec — match either form.
    expect(content).toMatch(/articleId: art-aaaaaaaa11112222/);
    expect(content).not.toContain("lastSyncWriteMtime");
    expect(content).toMatch(/\*\*world\*\*/);
  });

  // scenario-2: shouldSkip=true → no write performed
  it("scenario-2: shouldSkip=true → no write performed", async () => {
    const { settings } = makeSettings();
    const article = makeArticle();

    // First write — establishes the file.
    const r1 = await writer.writeArticle(
      article,
      "markdown",
      settings,
    );
    expect(r1.skipped).toBe(false);

    // Simulate the user opening Obsidian and editing the file: bump mtime
    // far past the sync-write mtime (5_000_000).
    adapter.__setMtime(r1.finalPath!, 9_999_999_999);
    // Replace body with user content (without touching mtime).
    const original = await storage.read(r1.finalPath!);
    const userEdited = original.replace(
      "**world**",
      "**user-edited content**",
    );
    await adapter.write(r1.finalPath!, userEdited);
    adapter.__setMtime(r1.finalPath!, 9_999_999_999);

    // Second write — must be skipped.
    const r2 = await writer.writeArticle(
      article,
      "markdown",
      settings,
    );
    expect(r2.skipped).toBe(true);
    expect(r2.reason).toBe("local edits detected");
    expect(r2.finalPath).toBe(r1.finalPath);

    // The user's edited content must remain untouched.
    const onDisk = await storage.read(r1.finalPath!);
    expect(onDisk).toContain("**user-edited content**");
  });

  // scenario-3: integration — full pipeline happy path with mock vault
  it("scenario-3: full pipeline happy path with mock vault", async () => {
    const { settings, store } = makeSettings();
    // First article — no conflict.
    const a1 = makeArticle({ id: "id-aaaaaaaa", feedItemId: "fi-id-aaaaaaaa", title: "Same Title" });
    const r1 = await writer.writeArticle(a1, "markdown", settings);
    expect(r1.finalPath).toBe("MyFeed/Same Title.md");
    expect(store.mappings["fi-id-aaaaaaaa"]).toBe("MyFeed/Same Title.md");

    // Second article — same intended path, must collide → suffix.
    settings.pathMappings = store.mappings;
    const a2 = makeArticle({ id: "id-bbbbbbbb", feedItemId: "fi-id-bbbbbbbb", title: "Same Title" });
    const r2 = await writer.writeArticle(a2, "markdown", settings);
    expect(r2.finalPath).toBe("MyFeed/Same Title-fi-id-bb.md");
    expect(await storage.exists("MyFeed/Same Title-fi-id-bb.md")).toBe(true);

    // Re-sync of a2 — must reuse stable mapping (idempotence).
    settings.pathMappings = store.mappings;
    const r3 = await writer.writeArticle(a2, "markdown", settings);
    expect(r3.finalPath).toBe("MyFeed/Same Title-fi-id-bb.md");
  });

  // scenario-4: integration — local-edit guard triggered, no overwrite
  it("scenario-4: integration — local-edit guard triggered, no overwrite", async () => {
    const article = makeArticle({ title: "Guarded" });
    const { settings } = makeSettings();

    const r1 = await writer.writeArticle(
      article,
      "markdown",
      settings,
    );
    const finalPath = r1.finalPath!;
    const before = await storage.read(finalPath);

    // User edits — bump mtime past stored lastSync (5_000_000).
    adapter.__setMtime(finalPath, 5_000_001);

    // Subsequent sync attempt with a slightly different bodyHtml.
    const updated = makeArticle({
      title: "Guarded",
      bodyHtml: "<p>NEW remote content.</p>",
    });
    const r2 = await writer.writeArticle(
      updated,
      "markdown",
      settings,
    );
    expect(r2.skipped).toBe(true);
    const after = await storage.read(finalPath);
    expect(after).toBe(before); // file untouched
  });

  // marker-1 — WRITE_PROCEED emitted on happy path
  it("emits WRITE_PROCEED marker on the happy path", async () => {
    const infoSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
    const { settings } = makeSettings();
    await writer.writeArticle(makeArticle(), "markdown", settings);
    const seen = infoSpy.mock.calls.some(
      (c) => (c[0] as { event?: string })?.event === "WRITE_PROCEED",
    );
    expect(seen).toBe(true);
    infoSpy.mockRestore();
  });

  // marker-2 — LOCAL_EDIT_SKIP emitted when guard fires
  it("emits LOCAL_EDIT_SKIP marker when guard skips overwrite", async () => {
    const { settings } = makeSettings();
    const article = makeArticle();
    const r1 = await writer.writeArticle(
      article,
      "markdown",
      settings,
    );
    adapter.__setMtime(r1.finalPath!, 9_999_999);

    const infoSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
    await writer.writeArticle(article, "markdown", settings);
    const seen = infoSpy.mock.calls.some(
      (c) => (c[0] as { event?: string })?.event === "LOCAL_EDIT_SKIP",
    );
    expect(seen).toBe(true);
    infoSpy.mockRestore();
  });

  // marker-3 — ARTICLE_WRITTEN emitted on successful write
  it("emits ARTICLE_WRITTEN marker on successful write", async () => {
    const infoSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
    const { settings } = makeSettings();
    await writer.writeArticle(makeArticle(), "markdown", settings);
    const seen = infoSpy.mock.calls.some(
      (c) => (c[0] as { event?: string })?.event === "ARTICLE_WRITTEN",
    );
    expect(seen).toBe(true);
    infoSpy.mockRestore();
  });

  // custom-file-template — uses fileTemplate from WriterSettings
  it("uses custom fileTemplate from WriterSettings", async () => {
    const customTemplate = `---
title: {{title}}
custom: true
---

{{text}}`;
    const { settings } = makeSettings({
      fileTemplate: customTemplate,
    });
    const article = makeArticle({ title: "Custom Template Test" });
    const result = await writer.writeArticle(
      article,
      "markdown",
      settings,
    );

    expect(result.skipped).toBe(false);
    const content = await storage.read(result.finalPath!);
    expect(content).toContain("title: Custom Template Test");
    expect(content).toContain("custom: true");
    expect(content).toContain("**world**");
    expect(content).not.toContain("articleId:");
  });

  // Persistence — settings.persistMappings receives delta on collisions
  it("calls settings.persistMappings only when a delta exists", async () => {
    const store = { mappings: {} as Record<string, string> };
    const persistSpy = vi.fn(async (delta: Record<string, string>) => {
      store.mappings = { ...store.mappings, ...delta };
    });
    const settings: WriterSettings = {
      pathTemplate: "{feedName}/{title}.md",
      outputFormat: "markdown",
      os: "linux",
      pathMappings: store.mappings,
      persistMappings: persistSpy,
    };
    await writer.writeArticle(
      makeArticle({ id: "id-1", feedItemId: "fi-id-1" }),
      "markdown",
      settings,
    );
    expect(persistSpy).toHaveBeenCalledTimes(1);

    // Re-sync with the existing mapping baked in → no delta to persist.
    settings.pathMappings = { ...store.mappings };
    persistSpy.mockClear();
    await writer.writeArticle(
      makeArticle({ id: "id-1", feedItemId: "fi-id-1" }),
      "markdown",
      settings,
    );
    expect(persistSpy).not.toHaveBeenCalled();
  });
});

// START_CHANGE_SUMMARY
// LAST_CHANGE: 2026-06-08 — migrate mappings assertions from articleId-keyed to feedItemId-keyed; set unique feedItemId per test article for collision detection (UC-016 fix)
// END_CHANGE_SUMMARY
