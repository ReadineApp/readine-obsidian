// START_MODULE_CONTRACT
// PURPOSE: Critical (hot spot ⚠#9) — per-article pipeline orchestrator. processArticle(article) checks network gating, builds WriterSettings from M-SETTINGS-MANAGER, then delegates to M-VAULT-WRITER which composes M-PATH-TEMPLATE + M-CONFLICT-RESOLVER + M-LOCAL-EDIT-GUARD + M-FORMAT-CONVERTER. Returns WriteResult (skipped | finalPath | mappingsUpdate). Critical invariant: never touches the vault when gating denies — early-return with reason='network_blocked'. Batch entry point processBatch(articles) snapshots the network state once at the start (mid-batch state changes are negligible per UC-003 §latency).
// SCOPE: src/sync/sync-files.ts
// DEPENDS: M-VAULT-WRITER, M-FORMAT-CONVERTER, M-NETWORK-GATE, M-NETWORK-DETECT, M-SETTINGS-MANAGER, M-ARTICLE-REGISTRY
// LINKS: UC-003, V-M-SYNC-FILES
// ROLE: RUNTIME
// MAP_MODE: EXPORTS
// END_MODULE_CONTRACT

// START_MODULE_MAP
// SyncFilesDeps - narrow DI seam wrapping VaultWriter + formatConverter + networkGate + networkDetect + settings
// SyncFiles - class with processArticle / processBatch (passes lastSyncWriteMtime from registry to VaultWriter)
// END_MODULE_MAP

import type { Connection } from "../network/network-detect";
import type { NetworkSetting } from "../network/network-gate";
import type { SettingsManager } from "../settings/settings-manager";
import type { ArticleRegistry } from "./article-registry";
import type { OSKind } from "../utils/path-template";
import type { convert as ConvertFn } from "../vault/format-converter";
import type {
  VaultWriter,
  WriteResult,
  WriterSettings,
} from "../vault/vault-writer";
import type { Article } from "./types";

// START_BLOCK_TYPES
/**
 * Dependency bag. Network gate / detect are passed as function objects so
 * tests substitute trivial stubs without dragging real M-NETWORK-DETECT
 * (which touches navigator.connection).
 */
export interface SyncFilesDeps {
  vaultWriter: VaultWriter;
  formatConverter: { convert: typeof ConvertFn };
  settings: SettingsManager;
  registry: ArticleRegistry;
  networkGate: {
    isAllowed: (setting: NetworkSetting, connection: Connection) => boolean;
  };
  networkDetect: { getConnection: () => Connection };
  /**
   * Override for the current OS (used by M-PATH-TEMPLATE sanitization). When
   * omitted we infer from process.platform — fine on desktop, harmless on
   * mobile (Obsidian Mobile reports "linux" via node-shim).
   */
  os?: OSKind;
}
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
    module: "M-SYNC-FILES",
    requirement: "UC-003",
    event,
    belief,
    ...details,
  });
}
// END_BLOCK_INTERNAL_LOG

// START_BLOCK_OS_RESOLVE
function inferOS(): OSKind {
  // Process.platform → OSKind. Conservative defaults to 'linux' (no sanitizer
  // surprises) for unrecognized values. Mobile platforms are not
  // distinguishable from process.platform in Obsidian; the plugin entry
  // point passes an explicit `os` for those.
  const p = typeof process !== "undefined" ? process.platform : undefined;
  if (p === "darwin") return "darwin";
  if (p === "win32") return "win32";
  return "linux";
}
// END_BLOCK_OS_RESOLVE

// START_CONTRACT: SyncFiles
// PURPOSE: per-article pipeline (gate → settings → VaultWriter)
// INPUTS: deps: SyncFilesDeps
// OUTPUTS: class with processArticle / processBatch
// SIDE_EFFECTS: writes to vault via VaultWriter; reads SettingsManager; emits WRITE_PROCEED + WRITE_BLOCKED / WRITE_DONE logs
// LINKS: UC-003, V-M-SYNC-FILES
// END_CONTRACT: SyncFiles
export class SyncFiles {
  private readonly vaultWriter: VaultWriter;
  private readonly settings: SettingsManager;
  private readonly registry: ArticleRegistry;
  private readonly networkGate: SyncFilesDeps["networkGate"];
  private readonly networkDetect: SyncFilesDeps["networkDetect"];
  private readonly os: OSKind;

  constructor(deps: SyncFilesDeps) {
    this.vaultWriter = deps.vaultWriter;
    // `formatConverter` is part of the DI bag (for symmetry with the contract
    // — Phase 8 plumbing) but the per-article conversion is delegated to
    // VaultWriter.writeArticle, which composes M-FORMAT-CONVERTER internally.
    // We keep the dep slot to make wiring explicit and to give future code
    // (e.g. a body-only preview) a hook without changing the constructor.
    void deps.formatConverter;
    this.settings = deps.settings;
    this.registry = deps.registry;
    this.networkGate = deps.networkGate;
    this.networkDetect = deps.networkDetect;
    this.os = deps.os ?? inferOS();
  }

  // START_CONTRACT: processArticle
  // PURPOSE: gate-check, build WriterSettings, delegate to VaultWriter.writeArticle
  // INPUTS: article: Article
  // OUTPUTS: Promise<WriteResult> — either { skipped, reason: 'network_blocked'|'local edits detected' } or written
  // SIDE_EFFECTS: vault write via VaultWriter; mappings persisted via registry.putPathMappings; emits WRITE_PROCEED / WRITE_BLOCKED logs
  // LINKS: UC-003, V-M-SYNC-FILES
  // END_CONTRACT: processArticle
  async processArticle(article: Article): Promise<WriteResult> {
    // START_BLOCK_GATE_CHECK
    const setting = this.settings.get("networkForArticles") as NetworkSetting;
    const conn = this.networkDetect.getConnection();
    const allowed = this.networkGate.isAllowed(setting, conn);
    if (!allowed) {
      logInfo(
        "processArticle:BLOCK_GATE_CHECK",
        "WRITE_BLOCKED",
        "network gate denied — skipping article",
        {
          articleId: article.id,
          setting,
          connectionType: conn.type,
          online: conn.online,
        },
      );
      return { skipped: true, reason: "network_blocked" };
    }
    logInfo(
      "processArticle:BLOCK_GATE_CHECK",
      "WRITE_PROCEED",
      "gate cleared — delegating to VaultWriter",
      { articleId: article.id, setting },
    );
    // END_BLOCK_GATE_CHECK

    // START_BLOCK_BUILD_SETTINGS
    // Snapshot once — set() on SettingsManager is async, so we capture the
    // current values to avoid races with concurrent writes from the UI.
    const pathTemplate = this.settings.get("pathTemplate");
    const outputFormat = this.settings.get("outputFormat");
    const fileTemplate = this.settings.get("fileTemplate");
    const pathMappings = this.registry.getPathMappings();
    const registryEntry = this.registry.get(article.feedItemId);
    const writerSettings: WriterSettings = {
      pathTemplate,
      outputFormat,
      fileTemplate,
      os: this.os,
      // Pass a shallow copy so the writer cannot mutate our snapshot.
      pathMappings: { ...pathMappings },
      // persistMappings receives only the DELTA (new mappings added by the
      // writer's conflict resolver). We merge with the registry's current
      // in-memory state.
      persistMappings: async (delta) => {
        this.registry.putPathMappings(delta);
      },
      // Pass registry.lastSyncWriteMtime so the write-guard has the true
      lastSyncWriteMtime: registryEntry?.lastSyncWriteMtime,
    };
    // END_BLOCK_BUILD_SETTINGS

    // START_BLOCK_DELEGATE
    const result = await this.vaultWriter.writeArticle(
      article,
      outputFormat,
      writerSettings,
    );
    logInfo(
      "processArticle:BLOCK_DELEGATE",
      "WRITE_DONE",
      "VaultWriter returned",
      {
        articleId: article.id,
        skipped: result.skipped,
        finalPath: result.finalPath ?? null,
      },
    );
    return result;
    // END_BLOCK_DELEGATE
  }

  // START_CONTRACT: processBatch
  // PURPOSE: sequential per-article pipeline over a batch of articles
  // INPUTS: articles: Article[]
  // OUTPUTS: Promise<WriteResult[]> — one result per input article, same order
  // SIDE_EFFECTS: as for processArticle, repeated per article
  // LINKS: UC-003, V-M-SYNC-FILES
  // END_CONTRACT: processBatch
  async processBatch(articles: Article[]): Promise<WriteResult[]> {
    // START_BLOCK_BATCH
    // Sequential to keep vault writes deterministic and avoid contention on
    // pathMappings (each write may update the mappings dictionary). The
    // adaptive worker pool (M-SYNC-LOADTASKS) is used at a higher level —
    // for backend fetches, not vault writes.
    const results: WriteResult[] = [];
    for (const article of articles) {
      const r = await this.processArticle(article);
      results.push(r);
    }
    return results;
    // END_BLOCK_BATCH
  }
}

// START_CHANGE_SUMMARY
// LAST_CHANGE: 2026-05-13 — initial Phase 5 M-SYNC-FILES implementation
// LAST_CHANGE: 2026-06-07 — add registry dep; use registry.getPathMappings/putPathMappings instead of settings
// LAST_CHANGE: 2026-06-08 — pass registryEntry.lastSyncWriteMtime through WriterSettings (UC-016 fix)
// END_CHANGE_SUMMARY
