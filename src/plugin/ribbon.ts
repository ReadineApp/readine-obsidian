// START_MODULE_CONTRACT
// PURPOSE: Add a single ribbon icon (Obsidian sidebar) that mirrors the "Sync now" command — clicking it invokes M-SYNC-ORCHESTRATOR.triggerSync('manual'). The icon uses the built-in 'refresh-cw' Lucide glyph (no asset required). Tooltip text comes from M-I18N so it follows the active UI language. When a NotificationsStore is provided, a badge with the unread count is appended next to the icon; the badge is hidden when notificationsBadge setting is false. Errors thrown by the orchestrator are caught and surfaced via Notice; we never let a rejection escape the ribbon callback (Obsidian would log it as an unhandled UI error). The returned HTMLElement gives tests + advanced consumers a reference to detach later if needed (Obsidian itself handles teardown on plugin.onunload via its registered-elements bookkeeping — no manual cleanup required).
// SCOPE: src/plugin/ribbon.ts
// DEPENDS: M-SYNC-ORCHESTRATOR, M-I18N, (optional) M-NOTIFICATIONS-STORE
// LINKS: UC-003, UC-022, V-M-RIBBON
// ROLE: RUNTIME
// MAP_MODE: EXPORTS
// END_MODULE_CONTRACT

// START_MODULE_MAP
// RIBBON_ICON_ID - frozen Lucide icon name used by the ribbon ('refresh-cw')
// BADGE_CLASS - CSS class for the unread badge element
// NotificationsBadgeDeps - DI bag for notifications badge rendering
// RibbonDeps - DI bag: orchestrator + i18n + optional noticeFactory + optional NotificationsStore + settings
// registerRibbon - imperative wiring step invoked from M-PLUGIN-MAIN.onload(); returns the icon HTMLElement
// END_MODULE_MAP

import { Notice, type Plugin } from "obsidian";

import type { I18n } from "../i18n/i18n-bridge";
import type { SyncOrchestrator, SyncResult } from "../sync/sync-orchestrator";

// START_BLOCK_CONSTANTS
const MODULE_ID = "M-RIBBON";

/**
 * Lucide icon id rendered into the ribbon button. Obsidian ships the Lucide
 * iconset and resolves names via `setIcon(el, name)`. 'refresh-cw' is the
 * counterclockwise refresh glyph — semantically "Sync now" matches it well.
 */
export const RIBBON_ICON_ID = "refresh-cw" as const;

/**
 * CSS class appended to the unread-count badge element. Consumers can style
 * the badge via `.readine-ribbon-badge` in their own CSS snippets if desired.
 */
export const BADGE_CLASS = "readine-ribbon-badge" as const;
// END_BLOCK_CONSTANTS

// START_BLOCK_TYPES
export interface NotificationsBadgeDeps {
  /** Subscribe to unread count updates. */
  unreadCount$: import("rxjs").Observable<number>;
  /** Get the current unread count synchronously. */
  getUnreadCount: () => number;
  /** Read the notificationsBadge toggle setting. */
  getNotificationsBadge: () => boolean;
  /** Subscribe to setting changes to show/hide the badge dynamically. */
  onNotificationsBadgeChange?: (cb: (enabled: boolean) => void) => () => void;
}

export interface RibbonDeps {
  orchestrator: SyncOrchestrator;
  i18n: I18n;
  /**
   * Optional Notice factory — same contract as M-COMMANDS. Production passes
   * `undefined` (so the default `new Notice(message)` runs); tests inject a
   * spy that captures the message string.
   */
  noticeFactory?: (message: string) => void;
  /**
   * Optional notifications badge state. When present, a badge with the
   * unread count is appended to the ribbon icon and auto-updated.
   */
  notificationsBadge?: NotificationsBadgeDeps;
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
  // eslint-disable-next-line no-console
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
  // eslint-disable-next-line no-console
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
function showNotice(deps: RibbonDeps, message: string): void {
  if (deps.noticeFactory) {
    try {
      deps.noticeFactory(message);
    } catch {
      // never let the spy throw block the ribbon callback
    }
    return;
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-unused-expressions
    new Notice(message);
  } catch {
    // In headless test envs without DOM Notice may throw; ignore.
  }
}

/** Mirror of the M-COMMANDS helper — kept local to avoid an export dance. */
function syncResultMessage(result: SyncResult, i18n: I18n): string {
  if (result.success) {
    return i18n.t("notice.sync_done", {
      written: String(result.written),
      attachments: String(result.attachmentsDownloaded),
    });
  }
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

// START_CONTRACT: registerRibbon
// PURPOSE: add the Readine sync ribbon icon to the Obsidian sidebar
// INPUTS: plugin: Plugin, deps: RibbonDeps
// OUTPUTS: HTMLElement — the icon element returned by Obsidian.addRibbonIcon (used by tests + advanced consumers)
// SIDE_EFFECTS: mounts a ribbon button; emits RIBBON_REGISTERED + RIBBON_CLICK markers
// LINKS: UC-003, V-M-RIBBON
// END_CONTRACT: registerRibbon
export function registerRibbon(plugin: Plugin, deps: RibbonDeps): HTMLElement {
  // START_BLOCK_ADD_ICON
  const tooltip = deps.i18n.t("ribbon.sync_now");
  const iconEl = plugin.addRibbonIcon(RIBBON_ICON_ID, tooltip, () => {
    // START_BLOCK_ON_CLICK
    logInfo(
      "onClick:BLOCK_ON_CLICK",
      "RIBBON_CLICK",
      "user clicked the Readine sync ribbon icon",
      "UC-003",
    );
    void deps.orchestrator
      .triggerSync("manual")
      .then((result) => {
        showNotice(deps, syncResultMessage(result, deps.i18n));
      })
      .catch((err: unknown) => {
        logWarn(
          "onClick:BLOCK_ON_CLICK",
          "RIBBON_CLICK_THREW",
          "triggerSync rejected unexpectedly — surfacing failure Notice",
          "UC-003",
          { err: err instanceof Error ? err.message : String(err) },
        );
        showNotice(deps, deps.i18n.t("notice.sync_failed"));
      });
    // END_BLOCK_ON_CLICK
  });
  logInfo(
    "registerRibbon:BLOCK_ADD_ICON",
    "RIBBON_REGISTERED",
    "ribbon icon mounted in sidebar",
    "UC-003",
    { icon: RIBBON_ICON_ID, tooltip },
  );

  // START_BLOCK_BADGE
  let badgeEl: HTMLElement | null = null;
  let badgeSub: (() => void) | null = null;

  if (deps.notificationsBadge) {
    const nb = deps.notificationsBadge;
    // Obsidian ribbon icon element may not have position:relative —
    // without it, the absolutely-positioned badge lands off-screen.
    iconEl.style.position = "relative";
    badgeEl = iconEl.createEl("span", { cls: BADGE_CLASS });

    const updateBadge = (): void => {
      if (!badgeEl) return;
      const enabled = nb.getNotificationsBadge();
      if (!enabled) {
        badgeEl.style.display = "none";
        return;
      }
      const count = nb.getUnreadCount();
      if (count > 0) {
        badgeEl.textContent = count > 99 ? "99+" : String(count);
        badgeEl.style.display = "";
      } else {
        badgeEl.style.display = "none";
      }
    };

    // Subscribe to count changes
    const sub = nb.unreadCount$.subscribe({ next: () => updateBadge() });
    badgeSub = () => sub.unsubscribe();

    // Listen for badge toggle changes
    if (nb.onNotificationsBadgeChange) {
      const off = nb.onNotificationsBadgeChange(() => updateBadge());
      const origUnsub = badgeSub;
      badgeSub = () => {
        origUnsub();
        off();
      };
    }

    updateBadge();
  }
  // END_BLOCK_BADGE

  // Store cleanup on the element for teardown
  if (badgeSub) {
    (iconEl as unknown as Record<string, unknown>)._badgeUnsubscribe = badgeSub;
  }

  return iconEl;
  // END_BLOCK_ADD_ICON
}

// START_CHANGE_SUMMARY
// LAST_CHANGE: 2026-05-13 — initial Phase 8 M-RIBBON implementation
// LAST_CHANGE: 2026-06-07 — fix badge positioning: set position:relative on iconEl; move badge styles to styles.css; add red color fallback
// END_CHANGE_SUMMARY
