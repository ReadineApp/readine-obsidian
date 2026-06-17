// START_MODULE_CONTRACT
// PURPOSE: Orchestrator: writeArticle composes PathTemplate + ConflictResolver + LocalEditGuard + FormatConverter + Base64Extractor + TemplateEngine + VaultFileStorage into a single safe-write pipeline. Two output modes: "markdown" (.md with user-configurable template and extracted base64 images), "html" (.html with user-configurable template). Critical invariant: ни одна перезапись без LocalEditGuard.
// SCOPE: src/vault/vault-writer.ts
// DEPENDS: M-VAULT-FILE-STORAGE, M-LOCAL-EDIT-GUARD, M-CONFLICT-RESOLVER, M-FORMAT-CONVERTER, M-TEMPLATE-ENGINE, M-PATH-TEMPLATE, M-BASE64-EXTRACTOR
// LINKS: UC-003, UC-013, UC-014, UC-017, V-M-VAULT-WRITER
// ROLE: RUNTIME
// MAP_MODE: EXPORTS
// END_MODULE_CONTRACT

// START_MODULE_MAP
// ReadineArticle - input type: id, feedItemId, title, url, date, tags, notes, bodyHtml, feedName, feedId, haveStar
// WriterSettings - per-write config: pathTemplate, outputFormat, os, pathMappings, persistMappings, fileTemplate, lastSyncWriteMtime
// WriteResult - { skipped, reason?, finalPath?, mappingsUpdate?, attachments? }
// VaultWriter - orchestrator class; constructor takes injected dependencies + linkPrefs + template engine
// VaultWriterDeps - DI bag for VaultWriter
// END_MODULE_MAP

import { renderPath, type OSKind } from "../utils/path-template";
import {
  buildTemplateVars,
  renderTemplate,
} from "../utils/template-engine";
import { resolvePath } from "./conflict-resolver";
import { convert, type OutputFormat } from "./format-converter";
import { shouldSkipOverwrite } from "./local-edit-guard";
import type { IFileStorage } from "../storage/vault-file-storage";
import {
  extractAttachments,
  type ObsidianLinkPrefs,
} from "../sync/base64-extractor";
import { DEFAULT_FILE_TEMPLATE } from "../constants";

// START_BLOCK_TYPES
export interface ReadineArticle {
  id: string;
  feedItemId: string;
  title: string;
  url: string;
  date: string;
  tags: string[];
  notes: string[];
  bodyHtml: string;
  feedName: string;
  feedId: string;
  haveStar: boolean;
}

export interface WriterSettings {
  pathTemplate: string;
  outputFormat: OutputFormat;
  os: OSKind;
  pathMappings: Record<string, string>;
  persistMappings: (newMappings: Record<string, string>) => Promise<void>;
  fileTemplate?: string;
  /** Sync-write mtime from ArticleRegistry entry. */
  lastSyncWriteMtime?: number;
}

export interface WriteResult {
  skipped: boolean;
  reason?: string;
  finalPath?: string;
  mappingsUpdate?: Record<string, string>;
  /** Extracted attachment paths (vault-relative). Defined only for markdown format. */
  attachments?: string[];
}

export interface VaultWriterDeps {
  storage: IFileStorage;
  linkPrefs: ObsidianLinkPrefs;
  pathTemplate?: typeof renderPath;
  conflictResolver?: typeof resolvePath;
  localEditGuard?: typeof shouldSkipOverwrite;
  formatConverter?: typeof convert;
  templateEngine?: {
    buildTemplateVars: typeof buildTemplateVars;
    renderTemplate: typeof renderTemplate;
  };
  defaultFileTemplate?: string;
  now?: () => number;
}
// END_BLOCK_TYPES

// START_BLOCK_VARS_BUILDER
/** Build variables for path template rendering (uses different keys than content templates). */
function buildPathTemplateVars(article: ReadineArticle): Record<string, string> {
  let yyyy = "";
  let mm = "";
  let dd = "";
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(article.date ?? "");
  if (match) {
    yyyy = match[1] ?? "";
    mm = match[2] ?? "";
    dd = match[3] ?? "";
  }
  const firstTag = article.tags?.[0] ?? "";
  return {
    feedName: article.feedName,
    feedId: article.feedId,
    tag: firstTag,
    firstTag,
    yyyy,
    mm,
    dd,
    title: article.title,
    articleId: article.id,
  };
}
// END_BLOCK_VARS_BUILDER

// START_BLOCK_INTERNAL_LOG
function logInfo(
  anchor: string,
  event: string,
  belief: string,
  details: Record<string, unknown> = {},
): void {
  console.debug({
    ts: new Date().toISOString(),
    level: "debug",
    anchor,
    module: "M-VAULT-WRITER",
    requirement: "UC-003",
    event,
    belief,
    ...details,
  });
}
// END_BLOCK_INTERNAL_LOG



// START_CONTRACT: VaultWriter
// PURPOSE: orchestrate safe article write with all guards + format-specific logic
// INPUTS: deps — { storage, linkPrefs, optional overrides for collaborators }
// OUTPUTS: class with writeArticle(article, format, settings): Promise<WriteResult>
// SIDE_EFFECTS: writes to vault via storage; calls settings.persistMappings; may extract base64 images
// LINKS: UC-003, UC-013, UC-014, UC-017, V-M-VAULT-WRITER
// END_CONTRACT: VaultWriter
export class VaultWriter {
  private readonly storage: IFileStorage;
  private readonly linkPrefs: ObsidianLinkPrefs;
  private readonly renderPathFn: typeof renderPath;
  private readonly resolvePathFn: typeof resolvePath;
  private readonly shouldSkipFn: typeof shouldSkipOverwrite;
  private readonly convertFn: typeof convert;
  private readonly buildVars: typeof buildTemplateVars;
  private readonly renderFn: typeof renderTemplate;
  private readonly defaultFileTemplate: string;

  private readonly now: () => number;

  constructor(deps: VaultWriterDeps) {
    this.storage = deps.storage;
    this.linkPrefs = deps.linkPrefs;
    this.renderPathFn = deps.pathTemplate ?? renderPath;
    this.resolvePathFn = deps.conflictResolver ?? resolvePath;
    this.shouldSkipFn = deps.localEditGuard ?? shouldSkipOverwrite;
    this.convertFn = deps.formatConverter ?? convert;
    this.buildVars = deps.templateEngine?.buildTemplateVars ?? buildTemplateVars;
    this.renderFn = deps.templateEngine?.renderTemplate ?? renderTemplate;
    this.defaultFileTemplate = deps.defaultFileTemplate ?? DEFAULT_FILE_TEMPLATE;

    this.now = deps.now ?? (() => Date.now());
  }

  // START_CONTRACT: writeArticle
  // PURPOSE: end-to-end safe write of a single article to the vault
  // INPUTS: article: ReadineArticle, format: OutputFormat, settings: WriterSettings
  // OUTPUTS: Promise<WriteResult>
  // SIDE_EFFECTS: vault write via storage; html format writes .html with raw body; markdown format converts+extracts
  // LINKS: UC-003, UC-013, UC-014, UC-017, V-M-VAULT-WRITER
  // END_CONTRACT: writeArticle
  async writeArticle(
    article: ReadineArticle,
    format: OutputFormat,
    settings: WriterSettings,
  ): Promise<WriteResult> {
    // START_BLOCK_RESOLVE_PATH
    const intendedPath = this.renderPathFn(
      settings.pathTemplate,
      buildPathTemplateVars(article),
      settings.os,
    );
    // HTML format writes .html, not .md
    const finalPath = format === "html"
      ? intendedPath.replace(/\.md$/, ".html")
      : intendedPath;
    const resolved = this.resolvePathFn(finalPath, article.feedItemId, settings.pathMappings);
    const writePath = resolved.finalPath;
    const mappingsUpdate = resolved.mappingsUpdate;
    // END_BLOCK_RESOLVE_PATH

    // START_BLOCK_GUARD_CHECK
    // Local-edit guard: if file exists AND user touched it since last sync → skip.
    const exists = await this.storage.exists(writePath);
    if (exists) {
      const stat = await this.storage.stat(writePath);
      const localMtime = stat?.mtime ?? 0;
      const lastSync = settings.lastSyncWriteMtime ?? 0;
      if (this.shouldSkipFn(localMtime, lastSync)) {
        logInfo(
          "writeArticle:BLOCK_GUARD_CHECK",
          "LOCAL_EDIT_SKIP",
          "local mtime exceeds lastSyncWriteMtime; skipping overwrite",
          { articleId: article.id, finalPath: writePath, localMtime, lastSync },
        );
        return { skipped: true, reason: "local edits detected", finalPath: writePath, mappingsUpdate };
      }
    }
    logInfo("writeArticle:BLOCK_GUARD_CHECK", "WRITE_PROCEED", "guard cleared; proceeding", { articleId: article.id, finalPath: writePath, exists });
    // END_BLOCK_GUARD_CHECK

    // START_BLOCK_FORMAT_HTML
    if (format === "html") {
      const htmlTemplate = "{{text}}";
      const htmlVars = this.buildVars(article, article.bodyHtml);
      const finalContent = this.renderFn(htmlTemplate, htmlVars);
      await this.storage.write(writePath, finalContent);
      if (Object.keys(mappingsUpdate).length > 0) await settings.persistMappings(mappingsUpdate);
      logInfo("writeArticle:BLOCK_FORMAT_HTML", "ARTICLE_WRITTEN", "html file written from template", { articleId: article.id, finalPath: writePath });
      return { skipped: false, finalPath: writePath, mappingsUpdate };
    }
    // END_BLOCK_FORMAT_HTML

    // START_BLOCK_FORMAT_MARKDOWN
    const markdown = this.convertFn(article.bodyHtml, "markdown");
    const dotMd = writePath.lastIndexOf(".md");
    const bodyPath = dotMd >= 0 ? writePath.slice(0, dotMd) : writePath;
    const slashIdx = bodyPath.lastIndexOf("/");
    const articleDir = slashIdx >= 0 ? bodyPath.slice(0, slashIdx) : "";
    const { body: updatedBody, attachments } = await extractAttachments(markdown, articleDir, article.id, this.storage, this.linkPrefs);
    const fileTemplate = settings.fileTemplate ?? this.defaultFileTemplate;
    const vars = this.buildVars(article, updatedBody);
    const finalContent = this.renderFn(fileTemplate, vars);

    await this.storage.write(writePath, finalContent);
    if (Object.keys(mappingsUpdate).length > 0) await settings.persistMappings(mappingsUpdate);
    logInfo("writeArticle:BLOCK_FORMAT_MARKDOWN", "ARTICLE_WRITTEN", "markdown file written from template", {
      articleId: article.id,
      finalPath: writePath,
      bytes: finalContent.length,
      attachments: attachments.length,
    });
    return { skipped: false, finalPath: writePath, mappingsUpdate };
    // END_BLOCK_FORMAT_MARKDOWN
  }
}

// START_CHANGE_SUMMARY
// LAST_CHANGE: 2026-06-01 — replace frontmatter-codec with template-engine; add configurable fileTemplate/htmlFileTemplate
// LAST_CHANGE: 2026-06-01 — logInfo: console.info → console.debug
// LAST_CHANGE: 2026-06-07 — extract articleName from writePath and pass to extractAttachments for subfolder naming
// LAST_CHANGE: 2026-06-08 — pass article.feedItemId (not article.id) to resolvePath for feedItemId-keyed pathMappings (UC-016 fix)
// LAST_CHANGE: 2026-06-08 — add lastSyncWriteMtime to WriterSettings; use registry mtime in write-guard (UC-016 fix)
// END_CHANGE_SUMMARY
