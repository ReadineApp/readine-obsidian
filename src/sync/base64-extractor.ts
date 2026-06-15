// START_MODULE_CONTRACT
// PURPOSE: Extract base64-encoded images from Markdown body during HTML→Markdown conversion. Writes decoded binary files to the configured attachment folder (from Obsidian settings), replaces data-URI references with wikilink or markdown links. Supports all 4 Obsidian attachment folder UI variants (same folder, vault root, subfolder under current, specified folder).
// SCOPE: src/sync/base64-extractor.ts
// DEPENDS: M-VAULT-FILE-STORAGE
// LINKS: UC-017, V-M-BASE64-EXTRACTOR
// ROLE: RUNTIME
// MAP_MODE: EXPORTS
// END_MODULE_CONTRACT

// START_MODULE_MAP
// ObsidianLinkPrefs - Obsidian link + attachment settings (useMarkdownLinks, newLinkFormat, attachmentFolderPath)
// ExtractResult - { body: string; attachments: string[] } — attachments are vault-relative paths
// extractAttachments - decode base64 data-URI, write files, replace links
// resolveTargetDir - resolve vault-relative attachment directory from Obsidian config + article context (4 UI variants)
// buildLink - construct wikilink or markdown link per settings
// removeAttachments - delete files listed in ArticleRegistry._attachments (not frontmatter)
// END_MODULE_MAP

import type { IFileStorage } from "../storage/vault-file-storage";

// START_BLOCK_TYPES
export interface ObsidianLinkPrefs {
  useMarkdownLinks: boolean;
  newLinkFormat: "shortest" | "relative" | "absolute";
  /**
   * Obsidian's attachment folder config (from `app.vault.getConfig("attachmentFolderPath")`).
   *
   * Convention used by Obsidian UI across all 4 options:
   * - `""` or `"."` → Same folder as current file
   * - `"./"`        → Vault folder (root)
   * - `"./sub"`     → In subfolder under current file (starts with `./`, article-relative)
   * - `"path"`      → In the folder specified below (vault-relative, no `./` prefix)
   */
  attachmentFolderPath?: string;
}

export interface ExtractResult {
  body: string;
  /** Full vault-relative paths of written attachment files. */
  attachments: string[];
}
// END_BLOCK_TYPES

// START_BLOCK_INTERNAL_LOG
function logInfo(
  anchor: string,
  event: string,
  belief: string,
  details: Record<string, unknown> = {},
): void {
  // eslint-disable-next-line no-console
  console.debug({
    ts: new Date().toISOString(),
    level: "info",
    anchor,
    module: "M-BASE64-EXTRACTOR",
    requirement: "UC-017",
    event,
    belief,
    ...details,
  });
}
// END_BLOCK_INTERNAL_LOG

const DATA_URI_RE = /!\[[^\]]*\]\((data:image\/(png|jpe?g|gif|webp|svg\+xml|x-icon|bmp);base64,([A-Za-z0-9+/=]+))\)/g;

function mimeToExt(mime: string): string {
  if (mime === "jpeg" || mime === "jpg") return "jpg";
  if (mime === "svg+xml") return "svg";
  if (mime === "x-icon") return "ico";
  return mime;
}

let counter = 0;

function nextFilename(ext: string, articleId: string): string {
  counter += 1;
  return `${articleId}-img-${String(counter).padStart(2, "0")}.${ext}`;
}

// START_BLOCK_PATH_HELPERS
function lstrip(s: string, ch: string): string {
  let i = 0;
  while (i < s.length && s[i] === ch) i++;
  return s.slice(i);
}

function rstrip(s: string, ch: string): string {
  let end = s.length;
  while (end > 0 && s[end - 1] === ch) end--;
  return s.slice(0, end);
}

function joinPath(a: string, b: string): string {
  const left = rstrip(a, "/");
  const right = lstrip(b, "/");
  if (!left) return right;
  if (!right) return left;
  return left + "/" + right;
}

function relativePath(fromDir: string, toPath: string): string {
  const fromParts = fromDir ? fromDir.split("/") : [];
  const toParts = toPath.split("/");

  let commonIdx = 0;
  while (
    commonIdx < fromParts.length &&
    commonIdx < toParts.length &&
    fromParts[commonIdx] === toParts[commonIdx]
  ) {
    commonIdx++;
  }

  const upParts = fromParts.slice(commonIdx).map(() => "..");
  const downParts = toParts.slice(commonIdx);

  return [...upParts, ...downParts].join("/");
}
// END_BLOCK_PATH_HELPERS

// START_CONTRACT: resolveTargetDir
// PURPOSE: map Obsidian attachmentFolderPath + article context → vault-relative target directory for extracted base64 images
// INPUTS: articleDir (vault-relative dir of the note), attachmentFolderPath (Obsidian config string)
// OUTPUTS: string — vault-relative directory where attachment files should be written (empty = vault root)
// SIDE_EFFECTS: none
// LINKS: UC-017
// END_CONTRACT: resolveTargetDir

// START_BLOCK_TARGET_DIR
export function resolveTargetDir(
  articleDir: string,
  attachmentFolderPath: string,
): string {
  const raw = (attachmentFolderPath ?? "").trim();

  if (!raw || raw === ".") return articleDir;

  if (raw === "./" || raw === "/") return "";

  const p = rstrip(lstrip(raw, "/"), "/");

  if (p.startsWith("./")) {
    const relPath = p.slice(2);
    return joinPath(articleDir, relPath);
  }

  return p;
}
// END_BLOCK_TARGET_DIR

// START_CONTRACT: extractAttachments
// PURPOSE: find all base64 data-URI images in a Markdown body, decode them to files, replace with vault links
// INPUTS: body: string, articleDir: string, articleId: string, storage: IFileStorage, linkPrefs: ObsidianLinkPrefs
// OUTPUTS: Promise<ExtractResult>
// SIDE_EFFECTS: writes binary files via storage; emits ATTACHMENT_EXTRACTED log per file
// LINKS: UC-017
// END_CONTRACT: extractAttachments
export async function extractAttachments(
  body: string,
  articleDir: string,
  articleId: string,
  storage: IFileStorage,
  linkPrefs: ObsidianLinkPrefs,
): Promise<ExtractResult> {
  const attachments: string[] = [];
  counter = 0;

  const targetDir = resolveTargetDir(articleDir, linkPrefs.attachmentFolderPath ?? ".");
  let updated = body;

  for (const match of body.matchAll(DATA_URI_RE)) {
    const fullMatch = match[0]!;
    const mime = match[2]!;
    const b64 = match[3]!;

    const ext = mimeToExt(mime);
    const filename = nextFilename(ext, articleId);

    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(
        atob(b64)
          .split("")
          .map((c) => c.charCodeAt(0)),
      );
    } catch {
      logInfo("extractAttachments", "B64_DECODE_FAILED", "invalid base64 — skipping", { mime });
      continue;
    }

    const filePath = targetDir ? joinPath(targetDir, filename) : filename;
    try {
      await storage.write(filePath, bytes.buffer as ArrayBuffer);
      attachments.push(filePath);
      logInfo("extractAttachments", "ATTACHMENT_EXTRACTED", "base64 image written", { filePath, ext });
    } catch (err) {
      logInfo("extractAttachments", "ATTACHMENT_WRITE_FAILED", "write failed", {
        filePath,
        error: err instanceof Error ? err.message : String(err),
      });
      continue;
    }

    const link = buildLink(filename, filePath, targetDir, articleDir, linkPrefs);
    updated = updated.replace(fullMatch, link);
  }

  return { body: updated, attachments };
}

// START_CONTRACT: buildLink
// PURPOSE: construct a vault link for an extracted attachment per Obsidian settings
// INPUTS: filename, filePath, targetDir, articleDir, linkPrefs
// OUTPUTS: string — wikilink (by name) or markdown link (relative/absolute per settings)
// SIDE_EFFECTS: none
// LINKS: UC-017
// END_CONTRACT: buildLink
export function buildLink(
  filename: string,
  _filePath: string,
  targetDir: string,
  articleDir: string,
  linkPrefs: ObsidianLinkPrefs,
): string {
  // Wikilink by filename — Obsidian resolves across the whole vault
  if (!linkPrefs.useMarkdownLinks) {
    return `![[${filename}]]`;
  }
  // Markdown link: compute path relative to the article
  if (linkPrefs.newLinkFormat === "absolute") {
    return `![](${_filePath})`;
  }
  // Relative: compute from articleDir to targetDir
  if (targetDir === articleDir) {
    return `![](${filename})`;
  }
  // Target is in a different folder — compute proper relative path from article to image
  return `![](${relativePath(articleDir, _filePath)})`;
}

// START_CONTRACT: removeAttachments
// PURPOSE: delete extracted attachment files listed in ArticleRegistry._attachments
// INPUTS: attachments: string[] (full vault-relative paths), storage: IFileStorage
// OUTPUTS: Promise<void>
// SIDE_EFFECTS: removes files via storage
// LINKS: UC-007, UC-011
// END_CONTRACT: removeAttachments
export async function removeAttachments(
  attachments: string[],
  storage: IFileStorage,
): Promise<void> {
  for (const path of attachments) {
    try {
      await storage.remove(path);
    } catch {
      // File already gone or inaccessible — safe to ignore
    }
  }
}

// START_CHANGE_SUMMARY
// LAST_CHANGE: 2026-06-07 — fix buildLink relative-path generation: compute proper relative path from article to image via new relativePath() helper instead of always returning vault-relative path (broke images in Obsidian when useMarkdownLinks=true and newLinkFormat≠absolute); add relativePath() helper using split-common-prefix algorithm
// END_CHANGE_SUMMARY
