// START_MODULE_CONTRACT
// PURPOSE: Pure decision: isAllowed(setting, connection) → boolean. Maps the four `networkForArticles` settings (always / Wi-Fi+cellular / Wi-Fi-only / off) onto the current Connection from M-NETWORK-DETECT. Single source of truth for «may this sync touch the network now?» — consumed by M-SYNC-FILES (article body fetch), M-ATTACHMENTS-DOWNLOADER (binary fetch) and M-AUTO-SYNC-TIMER (tick gating).
// SCOPE: src/network/network-gate.ts
// DEPENDS: M-NETWORK-DETECT, M-SETTINGS-MANAGER
// LINKS: UC-003, UC-004, UC-009, UC-017, V-M-NETWORK-GATE
// ROLE: RUNTIME
// MAP_MODE: EXPORTS
// END_MODULE_CONTRACT

// START_MODULE_MAP
// NetworkSetting - union type of the four networkForArticles values
// isAllowed - pure boolean decision per setting + current Connection
// END_MODULE_MAP

import type { Connection } from "./network-detect";

// START_BLOCK_TYPES
/**
 * The four values stored under `networkForArticles` (mirrors
 * SettingsSnapshot["networkForArticles"]). Kept as a local alias so this
 * module remains pure (no SettingsManager import) and is trivially testable.
 */
export type NetworkSetting =
  | "always"
  | "Wi-Fi+cellular"
  | "Wi-Fi-only"
  | "off";
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
    module: "M-NETWORK-GATE",
    requirement: "UC-009",
    event,
    belief,
    ...details,
  });
}
// END_BLOCK_INTERNAL_LOG

// START_CONTRACT: isAllowed
// PURPOSE: decide whether the current network passes the user's gating preference
// INPUTS: setting: NetworkSetting, connection: Connection (from M-NETWORK-DETECT.getConnection)
// OUTPUTS: boolean — true if the sync slice is allowed to touch the network
// SIDE_EFFECTS: emits NETWORK_GATE_DECISION info log
// LINKS: UC-003, UC-004, UC-009, UC-017, V-M-NETWORK-GATE
// END_CONTRACT: isAllowed
export function isAllowed(
  setting: NetworkSetting,
  connection: Connection,
): boolean {
  // START_BLOCK_DECIDE
  // Order of checks is significant:
  //   1. setting='off' short-circuits regardless of connection
  //   2. all other settings require online=true (offline → false)
  //   3. setting='always' is the only branch that does not inspect connection.type
  let allowed: boolean;
  switch (setting) {
    case "off":
      allowed = false;
      break;
    case "always":
      // 'always' deliberately ignores online status — callers that need the
      // online guard use `connection.online` directly. The contract here is
      // «user accepted any network, do not block on policy».
      allowed = true;
      break;
    case "Wi-Fi-only":
      // Only wifi while online passes. cellular/none/unknown → false.
      allowed = connection.online && connection.type === "wifi";
      break;
    case "Wi-Fi+cellular":
      // Online + recognized non-none transport (wifi or cellular).
      // 'unknown' is treated as «do not consume metered data»; safer default
      // for Obsidian Mobile where the connection API may be incomplete.
      allowed =
        connection.online &&
        (connection.type === "wifi" || connection.type === "cellular");
      break;
    default: {
      // Exhaustiveness guard — TS widens `setting` to `never` here.
      const _exhaustive: never = setting;
      throw new Error(`UNKNOWN_NETWORK_SETTING:${String(_exhaustive)}`);
    }
  }
  // END_BLOCK_DECIDE

  logInfo(
    "isAllowed:BLOCK_DECIDE",
    "NETWORK_GATE_DECISION",
    "gate decision per setting + current connection",
    { setting, connectionType: connection.type, online: connection.online, allowed },
  );
  return allowed;
}

// START_CHANGE_SUMMARY
// LAST_CHANGE: 2026-05-13 — initial Phase 5 M-NETWORK-GATE implementation
// END_CHANGE_SUMMARY
