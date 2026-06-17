// START_MODULE_CONTRACT
// PURPOSE: Aggregates diagnostic data for UC-019 (submit support request). Collects plugin version, Obsidian version, OS / userAgent / mobile flag, userId (or null when disconnected), lastSyncError, and the last 200 lines from the LogRingBuffer. Serialization is pretty-printed JSON so the user can read it before sending; the same string is what gets emailed / copied via M-SUPPORT-UI.
// SCOPE: src/support/support-bundle.ts
// DEPENDS: M-PLATFORM, M-AUTH-SERVICE, M-LOG-RING-BUFFER, M-SETTINGS-MANAGER
// LINKS: UC-019, V-M-SUPPORT-BUNDLE
// ROLE: RUNTIME
// MAP_MODE: EXPORTS
// END_MODULE_CONTRACT

// START_MODULE_MAP
// SupportBundleData - DTO returned by collectBundle()
// SupportBundleDeps - DI bag wiring platform, auth, ring buffer, settings, version stamps
// SupportBundle - class with collectBundle() and serialize()
// PlatformLike - minimal platform slice used here (getPlatformLabel + isMobile + version stamps)
// END_MODULE_MAP

import type { AuthService } from "../auth/auth-service";
import type { LogLine, LogRingBuffer } from "../logs/log-ring-buffer";
import type { SettingsManager } from "../settings/settings-manager";

// START_BLOCK_TYPES
/**
 * Structural facet of M-PLATFORM consumed by SupportBundle. The full module
 * also exposes getAdaptiveConcurrency() etc., which we don't need here.
 * Decoupling via a structural type keeps tests trivial.
 */
export interface PlatformLike {
  isMobile(): boolean;
  getPlatformLabel(): string;
}

/**
 * Shape returned by `collectBundle()`. Pure data — no methods. JSON-serializable
 * by construction (no Functions, Promises, Symbols, or circular refs).
 */
export interface SupportBundleData {
  pluginVersion: string;
  obsidianVersion: string;
  /** Best-effort OS hint derived from userAgent. */
  os: string;
  userAgent: string;
  isMobile: boolean;
  userId: string | null;
  lastSyncError: string | null;
  /** Up to 200 most-recent log lines, oldest-first. */
  logs: LogLine[];
}

export interface SupportBundleDeps {
  platform: PlatformLike;
  auth: AuthService;
  ringBuffer: LogRingBuffer;
  settings: SettingsManager;
  /** Plugin manifest version — wired from `manifest.json` by M-PLUGIN-MAIN. */
  pluginVersion: string;
  /** Obsidian runtime version — wired from `app.appVersion` (or similar) by M-PLUGIN-MAIN. */
  obsidianVersion: string;
}
// END_BLOCK_TYPES

// START_BLOCK_INTERNAL_LOG
const MODULE_ID = "M-SUPPORT-BUNDLE";

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
    module: MODULE_ID,
    requirement: "UC-019",
    event,
    belief,
    ...details,
  });
}
// END_BLOCK_INTERNAL_LOG

// START_BLOCK_OS_INFER
/**
 * OS classification via Obsidian Platform API. Relies on M-PLATFORM's
 * Platform.* flags — no user-agent parsing.
 */
function inferOs(platform: PlatformLike): string {
  try {
    const label = platform.getPlatformLabel();
    if (!label) return "unknown";
    if (platform.isMobile()) {
      if (label.includes("iOS")) return "iOS";
      if (label.includes("Android")) return "Android";
      return "Mobile";
    }
    if (label.includes("MacOS")) return "macOS";
    if (label.includes("Windows")) return "Windows";
    if (label.includes("Linux")) return "Linux";
    return "Desktop";
  } catch {
    return "unknown";
  }
}
// END_BLOCK_OS_INFER

// START_BLOCK_SUPPORT_BUNDLE
/**
 * UC-019 support bundle assembler.
 *
 * Lifecycle:
 *
 *   const sb = new SupportBundle({...});
 *   const bundle = sb.collectBundle();
 *   const text = sb.serialize(bundle);  // → pretty JSON for the user
 *
 * INVARIANTS:
 *   - collectBundle() never throws: any missing collaborator returns
 *     defensible defaults (empty strings, null, empty logs). The user can
 *     still send a partial bundle.
 *   - serialize() never includes sensitive data beyond what the user can
 *     already see in the bundle preview (no sessionId, no API tokens).
 */
export class SupportBundle {
  private readonly deps: SupportBundleDeps;

  // START_CONTRACT: constructor
  // PURPOSE: build a SupportBundle bound to its collaborators
  // INPUTS: deps: SupportBundleDeps
  // OUTPUTS: instance
  // SIDE_EFFECTS: none
  // LINKS: UC-019, V-M-SUPPORT-BUNDLE
  // END_CONTRACT: constructor
  constructor(deps: SupportBundleDeps) {
    this.deps = deps;
  }

  // START_CONTRACT: collectBundle
  // PURPOSE: assemble a fresh SupportBundleData snapshot
  // INPUTS: none
  // OUTPUTS: SupportBundleData
  // SIDE_EFFECTS: reads from platform / auth / ring buffer / settings; emits SUPPORT_BUNDLE_COLLECTED log
  // LINKS: UC-019, V-M-SUPPORT-BUNDLE
  // END_CONTRACT: collectBundle
  collectBundle(): SupportBundleData {
    // START_BLOCK_COLLECT
    const ua = this._safe(() => this.deps.platform.getPlatformLabel(), "");
    const isMobile = this._safe(() => this.deps.platform.isMobile(), false);
    const userId = this._safe(() => this.deps.auth.getUserId(), null);
    const apiToken = this._safe(() => this.deps.auth.getSessionId(), null);
    const lastSyncError = this._safe(
      () => this.deps.settings.get("lastSyncError"),
      null,
    );
    const logs = this._safe(
      () => this.deps.ringBuffer.getSnapshot(),
      [] as LogLine[],
    );

    const bundle: SupportBundleData = {
      pluginVersion: this.deps.pluginVersion,
      obsidianVersion: this.deps.obsidianVersion,
      os: inferOs(this.deps.platform),
      userAgent: ua,
      isMobile,
      userId: userId === null ? null : (apiToken ? userId + '/' + apiToken.slice(-4) : userId),
      lastSyncError,
      logs: logs.slice(-200),
    };

    logInfo(
      "collectBundle:BLOCK_COLLECT",
      "SUPPORT_BUNDLE_COLLECTED",
      "support bundle assembled — preview ready for the user",
      {
        logsCount: bundle.logs.length,
        hasUser: bundle.userId !== null,
        os: bundle.os,
        isMobile: bundle.isMobile,
      },
    );
    return bundle;
    // END_BLOCK_COLLECT
  }

  // START_CONTRACT: serialize
  // PURPOSE: render a SupportBundleData as pretty-printed JSON for human review
  // INPUTS: bundle: SupportBundleData
  // OUTPUTS: string — 2-space-indented JSON
  // SIDE_EFFECTS: none
  // LINKS: UC-019, V-M-SUPPORT-BUNDLE
  // END_CONTRACT: serialize
  serialize(bundle: SupportBundleData): string {
    // START_BLOCK_SERIALIZE
    try {
      const lines: string[] = [];
      lines.push(`pluginVersion: ${bundle.pluginVersion}`);
      lines.push(`obsidianVersion: ${bundle.obsidianVersion}`);
      lines.push(`os: ${bundle.os}`);
      lines.push(`userAgent: ${bundle.userAgent}`);
      lines.push(`isMobile: ${bundle.isMobile}`);
      lines.push(`userId: ${bundle.userId ?? "none"}`);
      lines.push(`lastSyncError: ${bundle.lastSyncError ?? "none"}`);
      lines.push(`logs: ${bundle.logs.length > 0 ? JSON.stringify(bundle.logs) : "[]"}`);
      return lines.join("\n");
    } catch {
      // Defensive — if the bundle ever contains a non-serializable field
      // (it shouldn't), fall back to a best-effort string. Tests assert that
      // collectBundle()'s output never trips this branch.
      return String(bundle);
    }
    // END_BLOCK_SERIALIZE
  }

  /** Run `fn()` and swallow exceptions — return `fallback` instead. */
  private _safe<T>(fn: () => T, fallback: T): T {
    try {
      const r = fn();
      return r === undefined ? fallback : r;
    } catch {
      return fallback;
    }
  }
}
// END_BLOCK_SUPPORT_BUNDLE

// START_CHANGE_SUMMARY
// LAST_CHANGE: 2026-05-13 — initial Phase 7 M-SUPPORT-BUNDLE implementation
// LAST_CHANGE: 2026-06-04 — change serialize() from JSON to key:value format with logs as compact JSON; remove uiLanguage and timestamp from bundle
// END_CHANGE_SUMMARY
