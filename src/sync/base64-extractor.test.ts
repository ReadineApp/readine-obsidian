// START_MODULE_CONTRACT
// PURPOSE: Tests for M-BASE64-EXTRACTOR.resolveTargetDir — all 4 Obsidian attachment folder UI variants, edge cases (null, whitespace, leading/trailing slashes, joinPath), no intermediate per-article subfolder.
// SCOPE: src/sync/base64-extractor.test.ts
// DEPENDS: M-BASE64-EXTRACTOR
// LINKS: V-M-BASE64-EXTRACTOR, UC-017
// ROLE: TEST
// END_MODULE_CONTRACT

// START_MODULE_MAP
// (test file — no public exports)
// END_MODULE_MAP

import { describe, expect, it } from "vitest";
import {
  buildLink,
  type ObsidianLinkPrefs,
  resolveTargetDir,
} from "./base64-extractor";

const DIR = "Articles/my-feed";
const FILENAME = "img-01.png";

// START_BLOCK_TESTS

describe("resolveTargetDir — 4 Obsidian UI variants (no per-article subfolder)", () => {
  // ── Case 1: Same folder as current file ──

  it("case 1 — '.' returns article directory", () => {
    expect(resolveTargetDir(DIR, ".")).toBe(DIR);
  });

  it("case 1 — '' returns article directory", () => {
    expect(resolveTargetDir(DIR, "")).toBe(DIR);
  });

  // ── Case 2: Vault folder (root) ──

  it("case 2 — './' returns empty string (vault root)", () => {
    expect(resolveTargetDir(DIR, "./")).toBe("");
  });

  it("case 2 — '/' returns empty string", () => {
    expect(resolveTargetDir(DIR, "/")).toBe("");
  });

  // ── Case 3: In subfolder under current file ──

  it("case 3 — './assets' → articleDir/assets", () => {
    expect(resolveTargetDir(DIR, "./assets")).toBe("Articles/my-feed/assets");
  });

  it("case 3 — './images/' (trailing slash) → articleDir/images", () => {
    expect(resolveTargetDir(DIR, "./images/")).toBe("Articles/my-feed/images");
  });

  it("case 3 — './_attachments' → articleDir/_attachments", () => {
    expect(resolveTargetDir(DIR, "./_attachments")).toBe("Articles/my-feed/_attachments");
  });

  it("case 3 — './sub/folder' → articleDir/sub/folder", () => {
    expect(resolveTargetDir(DIR, "./sub/folder")).toBe("Articles/my-feed/sub/folder");
  });

  // ── Case 4: In the folder specified below (vault-relative) ──

  it("case 4 — 'images' → images", () => {
    expect(resolveTargetDir(DIR, "images")).toBe("images");
  });

  it("case 4 — '_attachments' → _attachments", () => {
    expect(resolveTargetDir(DIR, "_attachments")).toBe("_attachments");
  });

  it("case 4 — 'assets/' (trailing slash) → assets", () => {
    expect(resolveTargetDir(DIR, "assets/")).toBe("assets");
  });

  it("case 4 — '/images' (leading slash) → images", () => {
    expect(resolveTargetDir(DIR, "/images")).toBe("images");
  });

  it("case 4 — 'static/img' → static/img", () => {
    expect(resolveTargetDir(DIR, "static/img")).toBe("static/img");
  });

  // ── Edge cases ──

  it("null/undefined → same folder (articleDir)", () => {
    expect(resolveTargetDir(DIR, undefined as unknown as string)).toBe(DIR);
    expect(resolveTargetDir(DIR, null as unknown as string)).toBe(DIR);
  });

  it("whitespace-only → same folder", () => {
    expect(resolveTargetDir(DIR, "   ")).toBe(DIR);
    expect(resolveTargetDir(DIR, "\t\n ")).toBe(DIR);
  });

  it("trim surrounding spaces from path", () => {
    expect(resolveTargetDir(DIR, "  assets  ")).toBe("assets");
    expect(resolveTargetDir(DIR, "  ./assets  ")).toBe("Articles/my-feed/assets");
  });

  it("multiple trailing slashes stripped", () => {
    expect(resolveTargetDir(DIR, "assets///")).toBe("assets");
    expect(resolveTargetDir(DIR, "./assets///")).toBe("Articles/my-feed/assets");
  });

  it("multiple leading slashes stripped", () => {
    expect(resolveTargetDir(DIR, "///assets")).toBe("assets");
  });

  it("articleDir with trailing slash + ./subfolder works", () => {
    expect(resolveTargetDir("Articles/my-feed/", "./IMAGES")).toBe("Articles/my-feed/IMAGES");
  });

  it("articleDir with trailing slash + vault-relative is unaffected", () => {
    expect(resolveTargetDir("Articles/my-feed/", "images")).toBe("images");
  });

  // ── Regression: case 3 must NOT be vault-relative ──

  it("./assets is article-relative, NOT vault-relative", () => {
    const result = resolveTargetDir(DIR, "./assets");
    expect(result).toBe("Articles/my-feed/assets");
    expect(result).not.toBe("assets");
  });

  // ── Empty articleDir (article at vault root) ──

  it("empty articleDir + '.' → empty", () => {
    expect(resolveTargetDir("", ".")).toBe("");
  });

  it("empty articleDir + './' → empty", () => {
    expect(resolveTargetDir("", "./")).toBe("");
  });

  it("empty articleDir + './assets' → assets", () => {
    expect(resolveTargetDir("", "./assets")).toBe("assets");
  });

  it("empty articleDir + 'images' → images", () => {
    expect(resolveTargetDir("", "images")).toBe("images");
  });

  // ── Vault root with both slashes stripped ──

  it("'./' leading/trailing stripped", () => {
    expect(resolveTargetDir(DIR, "  ./  ")).toBe("");
  });

  it("'/' leading/trailing stripped", () => {
    expect(resolveTargetDir(DIR, "  /  ")).toBe("");
  });

  // ── Result never starts with '/' ──

  it("result never has leading slash", () => {
    expect(resolveTargetDir("", "images")).toBe("images");
    expect(resolveTargetDir("", "images")[0]).not.toBe("/");
    expect(resolveTargetDir(DIR, "images")[0]).not.toBe("/");
    expect(resolveTargetDir(DIR, "./assets")[0]).not.toBe("/");
  });
});

// ── Helper ──

function lp(overrides: Partial<ObsidianLinkPrefs> = {}): ObsidianLinkPrefs {
  return {
    useMarkdownLinks: false,
    newLinkFormat: "relative",
    attachmentFolderPath: ".",
    ...overrides,
  };
}

// ── buildLink tests ──

describe("buildLink — all Obsidian link format combinations", () => {
  // ── Wikilinks ──

  it("wikilink — same folder", () => {
    expect(
      buildLink(FILENAME, `${DIR}/${FILENAME}`, DIR, DIR, lp()),
    ).toBe(`![[${FILENAME}]]`);
  });

  it("wikilink — vault root (case 2)", () => {
    expect(
      buildLink(FILENAME, FILENAME, "", DIR, lp()),
    ).toBe(`![[${FILENAME}]]`);
  });

  it("wikilink — vault-relative folder (case 4)", () => {
    expect(
      buildLink(FILENAME, `attachments/${FILENAME}`, "attachments", DIR, lp()),
    ).toBe(`![[${FILENAME}]]`);
  });

  it("wikilink — subfolder under article (case 3)", () => {
    expect(
      buildLink(
        FILENAME,
        `Articles/my-feed/assets/${FILENAME}`,
        "Articles/my-feed/assets",
        DIR,
        lp(),
      ),
    ).toBe(`![[${FILENAME}]]`);
  });

  // ── Markdown + absolute ──

  it("absolute — same folder", () => {
    const prefs = lp({ useMarkdownLinks: true, newLinkFormat: "absolute" });
    expect(
      buildLink(FILENAME, `${DIR}/${FILENAME}`, DIR, DIR, prefs),
    ).toBe(`![](${DIR}/${FILENAME})`);
  });

  it("absolute — vault root", () => {
    const prefs = lp({ useMarkdownLinks: true, newLinkFormat: "absolute" });
    expect(
      buildLink(FILENAME, FILENAME, "", DIR, prefs),
    ).toBe(`![](${FILENAME})`);
  });

  it("absolute — subfolder under article", () => {
    const prefs = lp({ useMarkdownLinks: true, newLinkFormat: "absolute" });
    expect(
      buildLink(
        FILENAME,
        `Articles/my-feed/assets/${FILENAME}`,
        "Articles/my-feed/assets",
        DIR,
        prefs,
      ),
    ).toBe(`![](Articles/my-feed/assets/${FILENAME})`);
  });

  it("absolute — vault-relative folder", () => {
    const prefs = lp({ useMarkdownLinks: true, newLinkFormat: "absolute" });
    expect(
      buildLink(
        FILENAME,
        `attachments/${FILENAME}`,
        "attachments",
        DIR,
        prefs,
      ),
    ).toBe(`![](attachments/${FILENAME})`);
  });

  // ── Markdown + relative : same folder → filename ──

  it("relative — same folder → filename only", () => {
    const prefs = lp({ useMarkdownLinks: true, newLinkFormat: "relative" });
    expect(
      buildLink(FILENAME, `${DIR}/${FILENAME}`, DIR, DIR, prefs),
    ).toBe(`![](${FILENAME})`);
  });

  // ── Markdown + relative : subfolder under article → relative subpath ──

  it("relative — './assets' → 'assets/filename'", () => {
    const prefs = lp({ useMarkdownLinks: true, newLinkFormat: "relative" });
    expect(
      buildLink(
        FILENAME,
        `Articles/my-feed/assets/${FILENAME}`,
        "Articles/my-feed/assets",
        DIR,
        prefs,
      ),
    ).toBe(`![](assets/${FILENAME})`);
  });

  it("relative — nested './sub/deep' → 'sub/deep/filename'", () => {
    const prefs = lp({ useMarkdownLinks: true, newLinkFormat: "relative" });
    expect(
      buildLink(
        FILENAME,
        `Articles/my-feed/sub/deep/${FILENAME}`,
        "Articles/my-feed/sub/deep",
        DIR,
        prefs,
      ),
    ).toBe(`![](sub/deep/${FILENAME})`);
  });

  // ── Markdown + relative : vault-relative folder → ../../folder/filename ──

  it("relative — 'attachments' → '../../attachments/filename'", () => {
    const prefs = lp({ useMarkdownLinks: true, newLinkFormat: "relative" });
    expect(
      buildLink(
        FILENAME,
        `attachments/${FILENAME}`,
        "attachments",
        DIR,
        prefs,
      ),
    ).toBe(`![](../../attachments/${FILENAME})`);
  });

  it("relative — 'static/img' → '../../static/img/filename'", () => {
    const prefs = lp({ useMarkdownLinks: true, newLinkFormat: "relative" });
    expect(
      buildLink(
        FILENAME,
        `static/img/${FILENAME}`,
        "static/img",
        DIR,
        prefs,
      ),
    ).toBe(`![](../../static/img/${FILENAME})`);
  });

  // ── Markdown + relative : vault root (case 2) → ../../filename ──

  it("relative — vault root → '../../filename'", () => {
    const prefs = lp({ useMarkdownLinks: true, newLinkFormat: "relative" });
    expect(
      buildLink(FILENAME, FILENAME, "", DIR, prefs),
    ).toBe(`![](../../${FILENAME})`);
  });

  // ── Markdown + shortest → same behavior as relative for different folders ──

  it("shortest — '../..' for vault-relative folder (same as relative)", () => {
    const prefs = lp({ useMarkdownLinks: true, newLinkFormat: "shortest" });
    expect(
      buildLink(
        FILENAME,
        `attachments/${FILENAME}`,
        "attachments",
        DIR,
        prefs,
      ),
    ).toBe(`![](../../attachments/${FILENAME})`);
  });

  it("shortest — same folder → filename", () => {
    const prefs = lp({ useMarkdownLinks: true, newLinkFormat: "shortest" });
    expect(
      buildLink(FILENAME, `${DIR}/${FILENAME}`, DIR, DIR, prefs),
    ).toBe(`![](${FILENAME})`);
  });

  it("shortest — subfolder → relative subpath", () => {
    const prefs = lp({ useMarkdownLinks: true, newLinkFormat: "shortest" });
    expect(
      buildLink(
        FILENAME,
        `Articles/my-feed/assets/${FILENAME}`,
        "Articles/my-feed/assets",
        DIR,
        prefs,
      ),
    ).toBe(`![](assets/${FILENAME})`);
  });

  // ── Edge cases ──

  it("article at vault root + relative — path from root", () => {
    const prefs = lp({ useMarkdownLinks: true, newLinkFormat: "relative" });
    expect(
      buildLink(
        FILENAME,
        `attachments/${FILENAME}`,
        "attachments",
        "",
        prefs,
      ),
    ).toBe(`![](attachments/${FILENAME})`);
  });

  it("article at vault root + same folder — filename", () => {
    const prefs = lp({ useMarkdownLinks: true, newLinkFormat: "relative" });
    expect(
      buildLink(FILENAME, FILENAME, "", "", prefs),
    ).toBe(`![](${FILENAME})`);
  });

  it("article at vault root + absolute", () => {
    const prefs = lp({ useMarkdownLinks: true, newLinkFormat: "absolute" });
    expect(
      buildLink(FILENAME, FILENAME, "", "", prefs),
    ).toBe(`![](${FILENAME})`);
  });
});

// END_BLOCK_TESTS

// START_CHANGE_SUMMARY
// LAST_CHANGE: 2026-06-07 — add buildLink tests covering all 3 newLinkFormat modes (absolute/relative/shortest) × 4 attachment folder variants (same/vault-root/subfolder/specified) + edge cases (article at vault root, nested subfolders, wikilinks); fix bug: relative mode now computes proper relative path from article to image instead of vault-relative path
// END_CHANGE_SUMMARY
