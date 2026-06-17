// START_MODULE_CONTRACT
// PURPOSE: Unit tests for M-PATH-TEMPLATE — renderPath, sanitizeComponent, validateTemplate.
// SCOPE: src/utils/path-template.test.ts
// DEPENDS: M-PATH-TEMPLATE
// LINKS: V-M-PATH-TEMPLATE
// ROLE: TEST
// END_MODULE_CONTRACT

// START_MODULE_MAP
// (test file — no public exports)
// END_MODULE_MAP

import { describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => import("../__mocks__/obsidian"));

import {
  OSKind,
  renderPath,
  sanitizeComponent,
  validateTemplate,
} from "./path-template";

const ALL_OS: OSKind[] = ["win32", "darwin", "linux", "ios", "android"];

const fullVars: Record<string, string> = {
  feedName: "My Feed",
  feedId: "feed-42",
  tag: "tech",
  firstTag: "tech",
  yyyy: "2026",
  mm: "05",
  dd: "13",
  title: "Hello World",
  articleId: "abc12345",
};

describe("M-PATH-TEMPLATE (V-M-PATH-TEMPLATE)", () => {
  // scenario-1: renderPath substitutes 9 placeholders
  it("scenario-1: substitutes all 9 known placeholders", () => {
    const template =
      "{feedName}/{feedId}/{tag}/{firstTag}/{yyyy}-{mm}-{dd}/{title}-{articleId}.md";
    const result = renderPath(template, fullVars, "linux");
    expect(result).toBe(
      "My Feed/feed-42/tech/tech/2026-05-13/Hello World-abc12345.md",
    );
  });

  // scenario-2: sanitize replaces 9 OS-invalid chars (/\:*?"<>|) → _
  it("scenario-2: sanitizes all 9 invalid chars in one component", () => {
    const input = 'a/b\\c:d*e?f"g<h>i|j';
    const cleaned = sanitizeComponent(input, "win32");
    expect(cleaned).not.toMatch(/[\\/:*?"<>|]/);
    // Each invalid char becomes "_" → 9 replacements.
    const underscoreCount = (cleaned.match(/_/g) ?? []).length;
    expect(underscoreCount).toBeGreaterThanOrEqual(9);
  });

  // scenario-3: sanitize truncates oversized components per OS limits
  it("scenario-3: truncates components longer than 200 chars", () => {
    const long = "x".repeat(500);
    for (const os of ALL_OS) {
      const cleaned = sanitizeComponent(long, os);
      expect(cleaned.length).toBeLessThanOrEqual(200);
    }
  });

  // scenario-4: table-driven — Windows/macOS/Linux/iOS/Android yield consistent valid output
  describe("scenario-4: table-driven per-OS rendering", () => {
    interface Row {
      os: OSKind;
      template: string;
      vars: Record<string, string>;
      expectFragment: string;
    }
    const table: Row[] = [
      {
        os: "win32",
        template: "{feedName}/{title}.md",
        vars: { feedName: "Tech", title: "Win 11 review" },
        expectFragment: "Tech/Win 11 review.md",
      },
      {
        os: "darwin",
        template: "{feedName}/{title}.md",
        vars: { feedName: "Tech", title: "macOS Tahoe" },
        expectFragment: "Tech/macOS Tahoe.md",
      },
      {
        os: "linux",
        template: "{feedName}/{title}.md",
        vars: { feedName: "Tech", title: "Linux 6.10" },
        expectFragment: "Tech/Linux 6.10.md",
      },
      {
        os: "ios",
        template: "{feedName}/{title}.md",
        vars: { feedName: "Tech", title: "iOS 19" },
        expectFragment: "Tech/iOS 19.md",
      },
      {
        os: "android",
        template: "{feedName}/{title}.md",
        vars: { feedName: "Tech", title: "Android 16" },
        expectFragment: "Tech/Android 16.md",
      },
    ];
    for (const row of table) {
      it(`${row.os}: ${row.template}`, () => {
        const out = renderPath(row.template, row.vars, row.os);
        expect(out).toContain(row.expectFragment);
      });
    }
  });

  // scenario-5: unknown placeholder → throws UNKNOWN_PLACEHOLDER
  it("scenario-5: throws UNKNOWN_PLACEHOLDER on unrecognised placeholder", () => {
    expect(() => renderPath("{nope}/{title}.md", { title: "x" }, "linux")).toThrow(
      "UNKNOWN_PLACEHOLDER",
    );
  });

  // scenario-6: integration — full template with all placeholders + sanitization
  it("scenario-6: integration — full 9-placeholder template end-to-end", () => {
    const template =
      "{feedName}/{feedId}/{yyyy}/{mm}/{dd}/{firstTag}/{tag}/{title}-{articleId}.md";
    const dirty: Record<string, string> = {
      ...fullVars,
      title: 'Hello/World:test*?"<>|',
    };
    const result = renderPath(template, dirty, "win32");
    // Forward slashes are component separators — sanitization happens *within* each component.
    // Only the path-separator slashes from the template itself should remain.
    expect(result.split("/")).toHaveLength(template.split("/").length);
    // The dirty title's invalid chars must be replaced.
    expect(result).not.toMatch(/[\\:*?"<>|]/);
  });

  it("empty template → throws", () => {
    expect(() => renderPath("", {}, "linux")).toThrow();
  });

  it("emits PATH_RESOLVED log marker on success", () => {
    const spy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    renderPath("{title}.md", { title: "x" }, "linux");
    const payload = spy.mock.calls.find(
      (c) =>
        typeof c[0] === "object" &&
        c[0] !== null &&
        (c[0] as Record<string, unknown>).event === "PATH_RESOLVED",
    )?.[0] as Record<string, unknown> | undefined;
    expect(payload).toBeDefined();
    expect(payload?.module).toBe("M-PATH-TEMPLATE");
    expect(payload?.anchor).toBe("renderPath:BLOCK_SANITIZE");
  });

  describe("validateTemplate()", () => {
    it("returns valid=true for a known-placeholder-only template", () => {
      const v = validateTemplate("{feedName}/{title}.md");
      expect(v.valid).toBe(true);
      expect(v.issues).toEqual([]);
    });

    it("returns valid=false with UNKNOWN_PLACEHOLDER:<key> on bad keys", () => {
      const v = validateTemplate("{feedName}/{nope}/{whatever}.md");
      expect(v.valid).toBe(false);
      expect(v.issues).toContain("UNKNOWN_PLACEHOLDER:nope");
      expect(v.issues).toContain("UNKNOWN_PLACEHOLDER:whatever");
    });

    it("returns valid=false on empty template", () => {
      const v = validateTemplate("");
      expect(v.valid).toBe(false);
      expect(v.issues).toContain("EMPTY_TEMPLATE");
    });

    it("emits TEMPLATE_INVALID log marker on invalid template", () => {
      const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
      validateTemplate("{nope}");
      const payload = spy.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(payload).toBeDefined();
      expect(payload.module).toBe("M-PATH-TEMPLATE");
      expect(payload.anchor).toBe("validateTemplate");
      expect(payload.event).toBe("TEMPLATE_INVALID");
    });
  });
});

// START_CHANGE_SUMMARY
// LAST_CHANGE: 2026-05-13 — initial test suite for V-M-PATH-TEMPLATE incl. per-OS table
// END_CHANGE_SUMMARY
