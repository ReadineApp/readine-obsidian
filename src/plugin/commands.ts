// START_MODULE_CONTRACT
// PURPOSE: Register Obsidian command-palette entries: sync-now (manual sync via M-SYNC-ORCHESTRATOR), disconnect (clears tokens via M-AUTH-SERVICE — vault untouched per UC-002 invariant). Each callback returns void; the underlying async work runs fire-and-forget (Obsidian's command-palette API does not await). On manual sync we surface a Notice with the SyncResult headline; on logout we show a "disconnected" Notice. Errors thrown by collaborators are caught and surfaced as Notice messages — the command-palette must never propagate a rejection back to Obsidian's UI thread (it would taint the modal).
// SCOPE: src/plugin/commands.ts
// DEPENDS: M-SYNC-ORCHESTRATOR, M-AUTH-SERVICE, M-I18N
// LINKS: UC-002, UC-003, V-M-COMMANDS
// ROLE: RUNTIME
// MAP_MODE: EXPORTS
// END_MODULE_CONTRACT

// START_MODULE_MAP
// CommandIds - frozen object with the two stable command ids (sync_now / disconnect)
// CommandsDeps - DI bag wiring orchestrator/auth/i18n
// registerCommands - imperative wiring step invoked from M-PLUGIN-MAIN.onload()
// END_MODULE_MAP

import { Notice, type Plugin } from "obsidian";

import type { AuthService } from "../auth/auth-service";
import type { I18n } from "../i18n/i18n-bridge";
import type { SyncOrchestrator, SyncResult } from "../sync/sync-orchestrator";

// START_BLOCK_CONSTANTS
const MODULE_ID = "M-COMMANDS";

/**
 * Stable command identifiers. Obsidian persists these in the user's keymap, so
 * renaming requires a migration. We freeze the bag to make accidental edits
 * stand out in code review.
 */
export const CommandIds = Object.freeze({
  SYNC_NOW: "sync-now",
  DISCONNECT: "disconnect",
} as const);
// END_BLOCK_CONSTANTS

// START_BLOCK_TYPES
/**
 * DI bag accepted by registerCommands. Each command callback closes over the
 * `deps` reference once; Obsidian holds the registered commands for the plugin
 * lifetime, so we cannot late-bind a new dependency after registration.
 */
export interface CommandsDeps {
  orchestrator: SyncOrchestrator;
  auth: AuthService;
  i18n: I18n;
  /**
   * Optional factory for Notice messages. Production passes the obsidian.Notice
   * constructor implicitly via the default; tests override to capture the
   * message string without actually showing a toast.
   */
  noticeFactory?: (message: string) => void;
}
// END_BLOCK_TYPES

// START_BLOCK_INTERNAL_LOG
function logInfo(
  anchor: string,
  event: string,
  belief: string,
  requirement: string,
  details: Record<string, unknown> = {},
): void {
  console.debug({
    ts: new Date().toISOString(),
    level: "info",
    anchor,
    module: MODULE_ID,
    requirement,
    event,
    belief,
    ...details,
  });
}

function logWarn(
  anchor: string,
  event: string,
  belief: string,
  requirement: string,
  details: Record<string, unknown> = {},
): void {
  console.warn({
    ts: new Date().toISOString(),
    level: "warn",
    anchor,
    module: MODULE_ID,
    requirement,
    event,
    belief,
    ...details,
  });
}
// END_BLOCK_INTERNAL_LOG

// START_BLOCK_HELPERS
function showNotice(deps: CommandsDeps, message: string): void {
  // Production default: instantiate obsidian.Notice (its constructor surfaces
  // the toast as a side-effect). Tests inject a spy to capture without
  // depending on the real obsidian.Notice mount.
  if (deps.noticeFactory) {
    try {
      deps.noticeFactory(message);
    } catch {
      // never let the spy throw block the command callback
    }
    return;
  }
  try {
    void new Notice(message);
  } catch {
    // In headless test envs without DOM Notice may throw; ignore.
  }
}

/** Build the user-facing string surfaced after a sync resolves. */
function syncResultMessage(result: SyncResult, i18n: I18n): string {
  if (result.success) {
    return i18n.t("notice.sync_done", {
      written: String(result.written),
      attachments: String(result.attachmentsDownloaded),
    });
  }
  // Map the stable error code onto a user-readable string. The keys are
  // namespaced under `notice.sync.*` so translators can localize independently.
  switch (result.error) {
    case "no_auth":
      return i18n.t("notice.sync_no_auth");
    case "NETWORK_BLOCKED":
      return i18n.t("notice.sync_network_blocked");
    case "session_expired":
      return i18n.t("notice.sync_session_expired");
    case "in_progress":
      return i18n.t("notice.sync_in_progress");
    case "internal_error":
    default:
      return i18n.t("notice.sync_failed");
  }
}
// END_BLOCK_HELPERS

// START_CONTRACT: registerCommands
// PURPOSE: register the three Readine command-palette entries on the host Plugin
// INPUTS: plugin: Plugin, deps: CommandsDeps
// OUTPUTS: void
// SIDE_EFFECTS: invokes plugin.addCommand three times; emits COMMAND_REGISTERED log marker per command
// LINKS: UC-002, UC-003, UC-021, V-M-COMMANDS
// END_CONTRACT: registerCommands
export function registerCommands(plugin: Plugin, deps: CommandsDeps): void {
  // START_BLOCK_REGISTER_SYNC
  plugin.addCommand({
    id: CommandIds.SYNC_NOW,
    name: deps.i18n.t("command.sync_now"),
    callback: () => {
      logInfo(
        "syncNow:BLOCK_INVOKE",
        "COMMAND_SYNC_INVOKED",
        "user invoked sync-now from command palette",
        "UC-003",
      );
      // Fire-and-forget; we surface a Notice with the headline outcome.
      void deps.orchestrator
        .triggerSync("manual")
        .then((result) => {
          showNotice(deps, syncResultMessage(result, deps.i18n));
        })
        .catch((err: unknown) => {
          logWarn(
            "syncNow:BLOCK_INVOKE",
            "COMMAND_SYNC_THREW",
            "triggerSync rejected unexpectedly — surfacing failure Notice",
            "UC-003",
            { err: err instanceof Error ? err.message : String(err) },
          );
          showNotice(deps, deps.i18n.t("notice.sync_failed"));
        });
    },
  });
  logInfo(
    "registerCommands:BLOCK_REGISTER_SYNC",
    "COMMAND_REGISTERED",
    "sync-now added to command palette",
    "UC-003",
    { id: CommandIds.SYNC_NOW },
  );
  // END_BLOCK_REGISTER_SYNC

  // START_BLOCK_REGISTER_DISCONNECT
  plugin.addCommand({
    id: CommandIds.DISCONNECT,
    name: deps.i18n.t("command.disconnect"),
    callback: () => {
      logInfo(
        "disconnect:BLOCK_INVOKE",
        "COMMAND_DISCONNECT_INVOKED",
        "user invoked disconnect from command palette",
        "UC-002",
      );
      // logout() clears sessionId / userId via M-SETTINGS-MANAGER; never
      // touches vault (UC-002 invariant).
      void deps.auth
        .logout()
        .then(() => {
          showNotice(deps, deps.i18n.t("notice.disconnected"));
        })
        .catch((err: unknown) => {
          logWarn(
            "disconnect:BLOCK_INVOKE",
            "COMMAND_DISCONNECT_THREW",
            "auth.logout rejected unexpectedly — surfacing failure Notice",
            "UC-002",
            { err: err instanceof Error ? err.message : String(err) },
          );
          showNotice(deps, deps.i18n.t("notice.disconnect_failed"));
        });
    },
  });
  logInfo(
    "registerCommands:BLOCK_REGISTER_DISCONNECT",
    "COMMAND_REGISTERED",
    "disconnect added to command palette",
    "UC-002",
    { id: CommandIds.DISCONNECT },
  );
  // END_BLOCK_REGISTER_DISCONNECT

}

// START_CHANGE_SUMMARY
// LAST_CHANGE: 2026-06-09 — strip "readine-" prefix from command ids (Obsidian auto-prefixes plugin id); update tests (DG-Authored: ai)
// END_CHANGE_SUMMARY
