// START_MODULE_CONTRACT
// PURPOSE: Unit tests for M-CONFLICT-RESOLVER — collision detection, suffix injection, idempotence, save/load cycle.
// SCOPE: src/vault/conflict-resolver.test.ts
// DEPENDS: M-CONFLICT-RESOLVER
// LINKS: V-M-CONFLICT-RESOLVER
// ROLE: TEST
// END_MODULE_CONTRACT

// START_MODULE_MAP
// (test file — no public exports)
// END_MODULE_MAP

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => import("../__mocks__/obsidian"));

import { __resetObsidianMock } from "../__mocks__/obsidian";
import { appendSuffixBeforeExt, resolvePath } from "./conflict-resolver";

describe("M-CONFLICT-RESOLVER (V-M-CONFLICT-RESOLVER)", () => {
  beforeEach(() => {
    __resetObsidianMock();
  });

  // scenario-1: no conflict → returns intended path unchanged
  it("scenario-1: no conflict → returns intended path unchanged", () => {
    const result = resolvePath("articles/hello.md", "feed-1234abcd", {});
    expect(result.finalPath).toBe("articles/hello.md");
    expect(result.mappingsUpdate).toEqual({
      "feed-1234abcd": "articles/hello.md",
    });
  });

  // scenario-2: conflict → suffix appended, mappingsUpdate emitted
  it("scenario-2: conflict → suffix appended, mappingsUpdate emitted", () => {
    const mappings = { "other-aaaa": "articles/hello.md" };
    const result = resolvePath("articles/hello.md", "feed-bbbb1111", mappings);
    expect(result.finalPath).toBe("articles/hello-feed-bbb.md");
    expect(result.mappingsUpdate).toEqual({
      "feed-bbbb1111": "articles/hello-feed-bbb.md",
    });
  });

  // scenario-3: same feedItemId re-queries with matching intendedPath → stable mapping (idempotence)
  it("scenario-3: same feedItemId re-queries with matching intendedPath → returns stable mapping (idempotence)", () => {
    // intendedPath matches the existing mapping — pure idempotency
    const mappings = { "feed-1": "articles/hello-feed-1.md" };
    const result = resolvePath("articles/hello-feed-1.md", "feed-1", mappings);
    expect(result.finalPath).toBe("articles/hello-feed-1.md");
    // No delta — already mapped.
    expect(result.mappingsUpdate).toEqual({});

    // Calling again with the unchanged result is still idempotent.
    const again = resolvePath("articles/hello-feed-1.md", "feed-1", {
      ...mappings,
      ...result.mappingsUpdate,
    });
    expect(again.finalPath).toBe("articles/hello-feed-1.md");
    expect(again.mappingsUpdate).toEqual({});
  });

  // scenario-5: path template change → resolves to new intended path, overwrites stale mapping
  it("scenario-5: path template change → resolves to new intended path, overwrites stale mapping", () => {
    // Simulates: user changed path template, re-logged, pressed sync.
    // Old mapping from previous template must NOT force the article back to the old path.
    const mappings = {
      "feed-1": "Readine/OldFeed/2026-06/Old Title.md",
    };
    // New intendedPath computed from the new template
    const result = resolvePath(
      "Readine/NewFeed/2026/New Title.md",
      "feed-1",
      mappings,
    );
    expect(result.finalPath).toBe("Readine/NewFeed/2026/New Title.md");
    expect(result.mappingsUpdate).toEqual({
      "feed-1": "Readine/NewFeed/2026/New Title.md",
    });
  });

  // scenario-6: path template change + collision → resolves with suffix on new path
  it("scenario-6: path template change + collision → resolves with suffix on new path", () => {
    const mappings = {
      "feed-1": "Readine/OldFeed/Old Title.md",
      "feed-aaaa": "Readine/NewFeed/New Title.md",
    };
    // New intendedPath collides with feed-aaaa's path
    const result = resolvePath(
      "Readine/NewFeed/New Title.md",
      "feed-1",
      mappings,
    );
    expect(result.finalPath).toBe("Readine/NewFeed/New Title-feed-1.md");
    expect(result.mappingsUpdate).toEqual({
      "feed-1": "Readine/NewFeed/New Title-feed-1.md",
    });
  });

  // scenario-4: save→load mappings cycle via settings-manager mock
  it("scenario-4: save→load mappings cycle preserves resolved paths", () => {
    const store: { mappings: Record<string, string> } = { mappings: {} };
    const settingsLoad = (): Record<string, string> => ({ ...store.mappings });
    const settingsSave = (delta: Record<string, string>): void => {
      store.mappings = { ...store.mappings, ...delta };
    };

    // First article — no conflict.
    const r1 = resolvePath("a/x.md", "feed-aaaaaaaa", settingsLoad());
    settingsSave(r1.mappingsUpdate);
    expect(store.mappings).toEqual({ "feed-aaaaaaaa": "a/x.md" });

    // Second article — same intended path, collision.
    const r2 = resolvePath("a/x.md", "feed-bbbbbbbb", settingsLoad());
    settingsSave(r2.mappingsUpdate);
    expect(r2.finalPath).toBe("a/x-feed-bbb.md");
    expect(store.mappings).toEqual({
      "feed-aaaaaaaa": "a/x.md",
      "feed-bbbbbbbb": "a/x-feed-bbb.md",
    });

    // Re-sync of article 2 — must reuse cached suffix.
    // intendedPath differs from the already-suffixed mapping,
    // but re-resolution via occupation check yields the same suffixed path.
    const r3 = resolvePath("a/x.md", "feed-bbbbbbbb", settingsLoad());
    expect(r3.finalPath).toBe("a/x-feed-bbb.md");
    // Delta overwrites the key with the same value — harmless no-op for the caller.
    expect(r3.mappingsUpdate).toEqual({ "feed-bbbbbbbb": "a/x-feed-bbb.md" });
  });

  // marker-1 — PATH_RESOLVED emitted on success path
  it("emits PATH_RESOLVED marker when no conflict", () => {
    const infoSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    resolvePath("a/b.md", "feed-1", {});
    const seen = infoSpy.mock.calls.some(
      (c) => (c[0] as { event?: string })?.event === "PATH_RESOLVED",
    );
    expect(seen).toBe(true);
    infoSpy.mockRestore();
  });

  // marker-2 — CONFLICT_SUFFIX_APPLIED emitted on collision
  it("emits CONFLICT_SUFFIX_APPLIED marker when suffix injected", () => {
    const infoSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    resolvePath("a/b.md", "feed-2zzzzzzz", { other: "a/b.md" });
    const seen = infoSpy.mock.calls.some(
      (c) => (c[0] as { event?: string })?.event === "CONFLICT_SUFFIX_APPLIED",
    );
    expect(seen).toBe(true);
    infoSpy.mockRestore();
  });

  describe("appendSuffixBeforeExt", () => {
    it("inserts suffix before .md extension", () => {
      expect(appendSuffixBeforeExt("foo.md", "-abc12345")).toBe(
        "foo-abc12345.md",
      );
    });

    it("appends to end when no extension", () => {
      expect(appendSuffixBeforeExt("foo", "-abc12345")).toBe("foo-abc12345");
    });

    it("handles nested paths with extension only in the leaf", () => {
      expect(appendSuffixBeforeExt("a/b/c.md", "-x")).toBe("a/b/c-x.md");
    });

    it("appends at end when dot lives in directory but not in leaf", () => {
      expect(appendSuffixBeforeExt("a.b/c", "-y")).toBe("a.b/c-y");
    });

    it("appends at end when path ends with a bare dot", () => {
      expect(appendSuffixBeforeExt("foo.", "-z")).toBe("foo.-z");
    });
  });
});

// START_CHANGE_SUMMARY
// LAST_CHANGE: 2026-06-08 — migrate all resolvePath calls and assertions from articleId-style keys to feedItemId-style keys (UC-016 fix)
// END_CHANGE_SUMMARY
