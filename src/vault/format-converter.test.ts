// START_MODULE_CONTRACT
// PURPOSE: Unit tests for M-FORMAT-CONVERTER — 2 formats × 4 samples + log markers + edge cases.
// SCOPE: src/vault/format-converter.test.ts
// DEPENDS: M-FORMAT-CONVERTER
// LINKS: V-M-FORMAT-CONVERTER
// ROLE: TEST
// END_MODULE_CONTRACT

// START_MODULE_MAP
// (test file — no public exports)
// END_MODULE_MAP

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => import("../__mocks__/obsidian"));

import { __resetObsidianMock } from "../__mocks__/obsidian";
import {
  convert,
  htmlToMarkdown,
  OutputFormat,
} from "./format-converter";

const SAMPLES = {
  simple: "<p>Hello, <strong>world</strong>!</p>",
  withCode:
    "<p>Run:</p><pre><code class=\"language-ts\">console.log('hi');</code></pre>",
  nested:
    "<ul><li>First with <strong>bold inside</strong> list item</li><li>Second</li></ul>",
  entities: "<p>A &amp; B &lt; C &gt; D &mdash; E &copy; 2026</p>",
};

const ALL_FORMATS: OutputFormat[] = [
  "markdown",
  "html",
];

describe("M-FORMAT-CONVERTER (V-M-FORMAT-CONVERTER)", () => {
  beforeEach(() => {
    __resetObsidianMock();
  });

  it("scenario-1: markdown converts <strong> to **bold**", () => {
    const out = convert(SAMPLES.simple, "markdown");
    expect(out).toMatch(/\*\*world\*\*/);
    expect(out).not.toMatch(/<strong>/);
  });

  it("scenario-2: html keeps raw markup", () => {
    const out = convert(SAMPLES.simple, "html");
    expect(out).toBe(SAMPLES.simple);
  });

  it("scenario-3: markdown strips tags and decodes entities", () => {
    const out = convert(SAMPLES.entities, "markdown");
    expect(out).not.toMatch(/<\/?p>/);
    expect(out).toContain("A & B < C > D — E © 2026");
  });

  describe("scenario-4: table-driven 4 × 2", () => {
    interface Row {
      name: keyof typeof SAMPLES;
      format: OutputFormat;
    }
    const table: Row[] = [];
    for (const name of Object.keys(SAMPLES) as Array<keyof typeof SAMPLES>) {
      for (const format of ALL_FORMATS) {
        table.push({ name, format });
      }
    }
    it.each(table)("sample=$name format=$format produces a string", ({ name, format }) => {
      const out = convert(SAMPLES[name], format);
      expect(typeof out).toBe("string");
      expect(out.length).toBeGreaterThan(0);
      if (format === "html") {
        expect(out).toBe(SAMPLES[name]);
      }
      if (format === "markdown") {
        expect(out).not.toMatch(/^---/);
      }
    });
  });

  it("scenario-5: embedded code blocks preserved in markdown", () => {
    const md = convert(SAMPLES.withCode, "markdown");
    expect(md).toMatch(/```/);
    expect(md).toContain("console.log('hi');");
  });

  it("scenario-6: nested formatting (bold inside list) preserved in markdown", () => {
    const md = convert(SAMPLES.nested, "markdown");
    expect(md).toMatch(/^[-*+] /m);
    expect(md).toMatch(/\*\*bold inside\*\*/);
  });

  it("scenario-7: turndown integration produces well-formed markdown", () => {
    const html =
      "<h1>Title</h1><p>Paragraph with <em>italic</em> and <a href=\"https://x\">link</a>.</p>";
    const md = htmlToMarkdown(html);
    expect(md).toMatch(/^#\s+Title/);
    expect(md).toMatch(/\*italic\*/);
    expect(md).toMatch(/\[link\]\(https:\/\/x\)/);
  });

  it("emits FORMAT_DISPATCHED marker from convert()", () => {
    const infoSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    convert(SAMPLES.simple, "markdown");
    const seen = infoSpy.mock.calls.some(
      (c) => (c[0] as { event?: string })?.event === "FORMAT_DISPATCHED",
    );
    expect(seen).toBe(true);
    infoSpy.mockRestore();
  });

  it("emits CONVERT_SUCCESS marker from htmlToMarkdown", () => {
    const infoSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    htmlToMarkdown(SAMPLES.simple);
    const seen = infoSpy.mock.calls.some(
      (c) => (c[0] as { event?: string })?.event === "CONVERT_SUCCESS",
    );
    expect(seen).toBe(true);
    infoSpy.mockRestore();
  });
});

// START_CHANGE_SUMMARY
// LAST_CHANGE: 2026-05-31 — rewrite for 2-format OutputFormat (markdown|html); remove fence/plain/asIs tests
// END_CHANGE_SUMMARY
