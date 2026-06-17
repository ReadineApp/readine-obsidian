// START_MODULE_CONTRACT
// PURPOSE: Tests for M-ARTICLE-BODY-LOADER — CDN candidate iteration, all-fail → null
// SCOPE: src/sync/article-body-loader.test.ts
// DEPENDS: M-ARTICLE-BODY-LOADER
// LINKS: V-M-ARTICLE-BODY-LOADER
// ROLE: TEST
// END_MODULE_CONTRACT

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CdnOrderStrategy } from "../api/clientV1_0";
import { resolveCdnUrlCandidates, type CdnStrategyLike } from "./cdn-resolver";

// START_MODULE_MAP
// (test file — no public exports)
// END_MODULE_MAP

// Obsidian mock provides requestUrl with __setRequestUrlImpl for per-test control.
vi.mock("obsidian", () => import("../__mocks__/obsidian"));
import { requestUrl, __setRequestUrlImpl } from "../__mocks__/obsidian";

import { ArticleBodyLoader } from "./article-body-loader";

function makeCdn(): CdnStrategyLike {
  return {
    orderStrategy: CdnOrderStrategy.Static,
    filenameStrategy: 100,
    configs: [
      { url: "https://cdn1.example.com" } as any,
      { url: "https://cdn2.example.com" } as any,
    ],
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function fakeResponse(status: number, arrayBuffer?: ArrayBuffer): any {
  return { status, arrayBuffer, text: "", headers: {}, json: null };
}

describe("M-ARTICLE-BODY-LOADER (V-M-ARTICLE-BODY-LOADER)", () => {
  let loader: ArticleBodyLoader;

  beforeEach(() => {
    // First CDN fails, second succeeds.
    let callIdx = 0;
    __setRequestUrlImpl(async () => {
      const idx = callIdx++;
      if (idx === 0) return { status: 500, headers: {}, text: "", json: null } as any;
      if (idx === 1) return { status: 200, headers: {}, text: "", json: null, arrayBuffer: new ArrayBuffer(10) } as any;
      return { status: 500, headers: {}, text: "", json: null } as any;
    });

    loader = new ArticleBodyLoader({
      storage: {
        exists: vi.fn().mockResolvedValue(false),
        read: vi.fn().mockRejectedValue(new Error("not found")),
        readBinary: vi.fn().mockRejectedValue(new Error("not found")),
        write: vi.fn().mockResolvedValue(undefined),
        remove: vi.fn().mockResolvedValue(undefined),
      } as any,
      unpackService: {
        unpack: vi.fn().mockResolvedValue("<p>hello</p>"),
      } as any,
    });
  });

  afterEach(() => {
    __setRequestUrlImpl(async () => ({ status: 200, headers: {}, text: "", json: null }) as any);
    vi.restoreAllMocks();
  });

  it("load: tries next CDN when first fails", async () => {
    const html = await loader.load("abc123", "dict-xyz", makeCdn());
    expect(html).toBe("<p>hello</p>");
    // Body: cdn1 fails (1) + cdn2 succeeds (1) = 2 HTTP calls
    // Dictionary cache miss: cdn1 fails (1) + cdn2 fails (1) = 2 HTTP calls
    // Total: 4 HTTP calls (body + dictionary)
    expect(requestUrl).toHaveBeenCalledTimes(4);
  });

  it("load: returns null when all CDN servers fail", async () => {
    // Both CDNs fail.
    __setRequestUrlImpl(async () => fakeResponse(500));

    const html = await loader.load("abc123", "dict-xyz", makeCdn());
    expect(html).toBeNull();
  });

  it("load: returns null when CDN config is empty", async () => {
    const html = await loader.load("abc123", "dict-xyz", null);
    expect(html).toBeNull();
  });

  it("load: decompress failure returns null", async () => {
    loader = new ArticleBodyLoader({
      storage: {
        exists: vi.fn().mockResolvedValue(false),
        read: vi.fn().mockRejectedValue(new Error("not found")),
        readBinary: vi.fn().mockRejectedValue(new Error("not found")),
        write: vi.fn().mockResolvedValue(undefined),
        remove: vi.fn().mockResolvedValue(undefined),
      } as any,
      unpackService: {
        unpack: vi.fn().mockRejectedValue(new Error("decompress error")),
      } as any,
    });

    const html = await loader.load("abc123", "dict-xyz", makeCdn());
    expect(html).toBeNull();
  });

  it("load: uses cached dictionary without CDN download", async () => {
    vi.clearAllMocks();

    // Body only: cdn1 fails, cdn2 succeeds (2 calls), dict from cache (0 calls).
    let callIdx = 0;
    __setRequestUrlImpl(async () => {
      const idx = callIdx++;
      if (idx === 0) return { status: 500, headers: {}, text: "", json: null } as any;
      if (idx === 1) return { status: 200, headers: {}, text: "", json: null, arrayBuffer: new ArrayBuffer(10) } as any;
      return { status: 500, headers: {}, text: "", json: null } as any;
    });

    const dictBytes = new Uint8Array([1, 2, 3, 4, 5]).buffer;
    loader = new ArticleBodyLoader({
      storage: {
        exists: vi.fn().mockResolvedValue(false),
        read: vi.fn().mockRejectedValue(new Error("not found")),
        readBinary: vi.fn().mockResolvedValue(dictBytes),
        write: vi.fn().mockResolvedValue(undefined),
        remove: vi.fn().mockResolvedValue(undefined),
      } as any,
      unpackService: {
        unpack: vi.fn().mockResolvedValue("<p>cached-dict</p>"),
      } as any,
    });

    const html = await loader.load("abc123", "dict-xyz", makeCdn());
    expect(html).toBe("<p>cached-dict</p>");
    // Only 2 HTTP calls (body: cdn1 fail + cdn2 success), no dict CDN calls.
    expect(requestUrl).toHaveBeenCalledTimes(2);
  });
});

// START_CHANGE_SUMMARY
// LAST_CHANGE: 2026-06-04 — initial test file for CDN failover iteration
// END_CHANGE_SUMMARY
