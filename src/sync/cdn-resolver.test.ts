// START_MODULE_CONTRACT
// PURPOSE: Tests for M-CDN-RESOLVER — resolveCdnUrlCandidates ordering (Static/Random)
// SCOPE: src/sync/cdn-resolver.test.ts
// DEPENDS: M-CDN-RESOLVER
// LINKS: V-M-CDN-RESOLVER
// ROLE: TEST
// END_MODULE_CONTRACT

// START_MODULE_MAP
// (test file — no public exports)
// END_MODULE_MAP

import { describe, expect, it, vi } from "vitest";
vi.mock("obsidian", () => import("../__mocks__/obsidian"));
import { CdnOrderStrategy } from "../api/clientV1_0";
import { resolveCdnUrlCandidates, type CdnStrategyLike } from "./cdn-resolver";

function makeStrategy(
  overrides: Partial<CdnStrategyLike> = {},
): CdnStrategyLike {
  return {
    orderStrategy: CdnOrderStrategy.Static,
    filenameStrategy: 100,
    configs: [{ url: "https://cdn1.example.com" } as any, { url: "https://cdn2.example.com" } as any],
    ...overrides,
  };
}

describe("M-CDN-RESOLVER (V-M-CDN-RESOLVER)", () => {
  describe("resolveCdnUrlCandidates", () => {
    it("returns candidates in Static order", () => {
      const urls = resolveCdnUrlCandidates(
        makeStrategy({ orderStrategy: CdnOrderStrategy.Static }),
        "abc123",
        "article",
      );
      expect(urls).toHaveLength(2);
      expect(urls[0]).toContain("cdn1.example.com");
      expect(urls[1]).toContain("cdn2.example.com");
    });

    it("shuffles candidates for Random strategy", () => {
      const results = new Set<string>();
      for (let i = 0; i < 20; i++) {
        const urls = resolveCdnUrlCandidates(
          makeStrategy({ orderStrategy: CdnOrderStrategy.Random }),
          "abc123",
          "article",
        );
        results.add(urls.join("|"));
      }
      expect(results.size).toBeGreaterThan(1);
    });

    it("filters out servers with empty url", () => {
      const urls = resolveCdnUrlCandidates(
        makeStrategy({
          configs: [{ url: "https://cdn1.example.com" } as any, { url: "" } as any, { url: "https://cdn3.example.com" } as any],
        }),
        "abc123",
        "article",
      );
      expect(urls).toHaveLength(2);
    });

    it("returns empty array when no configs", () => {
      const urls = resolveCdnUrlCandidates(
        makeStrategy({ configs: [] }),
        "abc123",
        "article",
      );
      expect(urls).toEqual([]);
    });

    it("returns empty array when strategy is null", () => {
      expect(resolveCdnUrlCandidates(null, "abc123", "article")).toEqual([]);
    });

    it("builds correct URL for article and dictionary file types", () => {
      const urls = resolveCdnUrlCandidates(
        makeStrategy({ configs: [{ url: "https://cdn.example.com" } as any] }),
        "abc123",
        "article",
      );
      expect(urls[0]).toBe("https://cdn.example.com/bc/abc123");

      const dictUrls = resolveCdnUrlCandidates(
        makeStrategy({ configs: [{ url: "https://cdn.example.com" } as any] }),
        "dict-xyz",
        "dictionary",
      );
      expect(dictUrls[0]).toBe("https://cdn.example.com/_d/dict-xyz");
    });

    it("strips trailing slash from base URL", () => {
      const urls = resolveCdnUrlCandidates(
        makeStrategy({ configs: [{ url: "https://cdn.example.com/" } as any] }),
        "abc123",
        "article",
      );
      expect(urls[0]).toBe("https://cdn.example.com/bc/abc123");
    });

    it("exclude param: filters out tried URLs for Static", () => {
      const urls = resolveCdnUrlCandidates(
        makeStrategy({ orderStrategy: CdnOrderStrategy.Static }),
        "abc123",
        "article",
        ["https://cdn1.example.com/bc/abc123"],
      );
      expect(urls).toHaveLength(1);
      expect(urls[0]).toContain("cdn2.example.com");
    });

    it("exclude param: wraps around when all URLs excluded (Static)", () => {
      const urls = resolveCdnUrlCandidates(
        makeStrategy({ orderStrategy: CdnOrderStrategy.Static }),
        "abc123",
        "article",
        ["https://cdn1.example.com/bc/abc123", "https://cdn2.example.com/bc/abc123"],
      );
      expect(urls).toHaveLength(2);
    });
  });
});

// START_CHANGE_SUMMARY
// LAST_CHANGE: 2026-06-04 — initial test file for resolveCdnUrlCandidates
// END_CHANGE_SUMMARY
