// START_MODULE_CONTRACT
// PURPOSE: HTML→target-format converter for synced articles. Two output formats: markdown (turndown-based) and html (raw, preserved for .html files).
// SCOPE: src/vault/format-converter.ts
// DEPENDS: none
// LINKS: UC-005, UC-003, V-M-FORMAT-CONVERTER
// ROLE: RUNTIME
// MAP_MODE: EXPORTS
// END_MODULE_CONTRACT

// START_MODULE_MAP
// OutputFormat - "markdown" | "html"
// convert - dispatch to format-specific converter
// htmlToMarkdown - turndown-based; preserves code blocks, tables, formatting
// END_MODULE_MAP

import TurndownService from "turndown";

// START_BLOCK_TYPES
export type OutputFormat =
  | "markdown"
  | "html";
// END_BLOCK_TYPES

// START_BLOCK_INTERNAL_LOG
function logInfo(
  anchor: string,
  event: string,
  belief: string,
  details: Record<string, unknown> = {},
): void {
  console.debug({
    ts: new Date().toISOString(),
    level: "info",
    anchor,
    module: "M-FORMAT-CONVERTER",
    requirement: "UC-005",
    event,
    belief,
    ...details,
  });
}
// END_BLOCK_INTERNAL_LOG

// START_BLOCK_TURNDOWN_INIT
/**
 * Single Turndown instance — construction is cheap but creating it per call
 * inflates the hot-spot conversion path on large batches.
 *
 * GFM-like options: fenced code blocks, ATX headings, `*` for emphasis.
 */
const turndown = new TurndownService({
  codeBlockStyle: "fenced",
  headingStyle: "atx",
  emDelimiter: "*",
  bulletListMarker: "-",
  strongDelimiter: "**",
  fence: "```",
});
// END_BLOCK_TURNDOWN_INIT

// START_CONTRACT: htmlToMarkdown
// PURPOSE: convert HTML to Markdown via turndown; preserves code blocks, tables, nested formatting
// INPUTS: html: string
// OUTPUTS: string — markdown body (no frontmatter; that is added by M-VAULT-WRITER)
// SIDE_EFFECTS: emits CONVERT_SUCCESS info log
// LINKS: UC-005, V-M-FORMAT-CONVERTER
// END_CONTRACT: htmlToMarkdown
export function htmlToMarkdown(html: string): string {
  const out = turndown.turndown(html);
  logInfo(
    "htmlToMarkdown",
    "CONVERT_SUCCESS",
    "html turned to markdown via turndown",
    { inputLength: html.length, outputLength: out.length },
  );
  return out;
}

// START_CONTRACT: convert
// PURPOSE: dispatch HTML conversion to the requested format
// INPUTS: html: string, format: OutputFormat
// OUTPUTS: string — converted body (no frontmatter; that is M-VAULT-WRITER's concern)
// SIDE_EFFECTS: none
// LINKS: UC-005, V-M-FORMAT-CONVERTER
// END_CONTRACT: convert
export function convert(html: string, format: OutputFormat): string {
  // START_BLOCK_DISPATCH
  logInfo("convert:BLOCK_DISPATCH", "FORMAT_DISPATCHED", "format chosen", {
    format,
    inputLength: html.length,
  });
  switch (format) {
    case "markdown":
      return htmlToMarkdown(html);
    case "html":
      return html;
    default: {
      const _exhaustive: never = format;
      throw new Error(`UNKNOWN_FORMAT:${String(_exhaustive)}`);
    }
  }
  // END_BLOCK_DISPATCH
}

// START_CHANGE_SUMMARY
// LAST_CHANGE: 2026-05-30 — simplify to markdown|html formats; remove fence/plain/asIs
// END_CHANGE_SUMMARY
