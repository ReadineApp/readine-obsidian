// START_MODULE_CONTRACT
// PURPOSE: Renders the Authentication section of the Settings Tab. When the user is logged in, shows a "Connected as <userId>" line + Disconnect button. When logged out, shows a paste-code textarea + Connect button. A re-auth banner surfaces UC-015 (session expired) state — driven by both the live AuthEvent stream and the lastSyncError settings hint. Subscribes to AuthService events for the lifetime of the rendered section; the caller must invoke the returned unsubscribe handle when the section is torn down.
// SCOPE: src/ui/auth-ui.ts
// DEPENDS: M-AUTH-SERVICE, M-I18N
// LINKS: UC-001, UC-002, UC-015, V-M-AUTH-UI
// ROLE: RUNTIME
// MAP_MODE: EXPORTS
// END_MODULE_CONTRACT

// START_MODULE_MAP
// AuthUI - main class with renderAuthSection(container) returning an unsubscribe handle
// AuthUIDeps - DI bag with AuthService + I18n + optional Notice factory
// AuthUIHandle - typedef for the unsubscribe handle returned by renderAuthSection() (() => void)
// END_MODULE_MAP

import { Setting } from "obsidian";

import type { AuthService } from "../auth/auth-service";
import type { I18n } from "../i18n/i18n-bridge";

// START_BLOCK_TYPES
/**
 * DI bag for AuthUI. The optional `onLoginOutcome` hook is consumed by the
 * Settings Tab in Phase 7 — wires Notice messages on success / error without
 * the AuthUI itself needing the obsidian.Notice constructor.
 */
export interface AuthUIDeps {
  auth: AuthService;
  i18n: I18n;
  /** Fired after login() resolves. Optional. */
  onLoginOutcome?: (outcome: {
    ok: boolean;
    userId?: string;
    error?: string;
  }) => void;
  /** Fired after logout() resolves. Optional. */
  onDisconnect?: () => void;
  /**
   * Optional probe for "is there a stale session-expired error in settings"
   * — typically wired to `settings.get('lastSyncError') === 'session_expired'`.
   * When omitted, the banner is driven solely by the AuthEvent stream.
   */
  hasSessionExpiredFlag?: () => boolean;
}

/** Handle returned by `renderAuthSection` — call to detach listeners. */
export interface AuthUIHandle {
  unsubscribe(): void;
  /** Re-render imperatively; consumers (Settings Tab) call this after a language switch. */
  rerender(): void;
}
// END_BLOCK_TYPES

// START_BLOCK_INTERNAL_LOG
const MODULE_ID = "M-AUTH-UI";

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

// START_BLOCK_AUTH_UI
/**
 * UI section renderer for the Authentication block of the Settings Tab.
 *
 * Lifecycle:
 *
 *   const ui = new AuthUI({ auth, i18n });
 *   const handle = ui.renderAuthSection(containerEl);
 *   // ... later, on tab teardown:
 *   handle.unsubscribe();
 *
 * Re-render policy: any AuthEvent (`auth.login_success` | `auth.disconnected`
 * | `session-expired` | `auth.ready`) triggers a full re-render of the
 * section. We use `containerEl.empty()` followed by re-population — Obsidian's
 * idiomatic pattern (see PluginSettingTab.display).
 */
export class AuthUI {
  private readonly deps: AuthUIDeps;
  private currentContainer: HTMLElement | null = null;
  private currentBannerVisible = false;

  // START_CONTRACT: constructor
  // PURPOSE: build an AuthUI bound to its dependencies
  // INPUTS: deps: AuthUIDeps
  // OUTPUTS: instance
  // SIDE_EFFECTS: none until renderAuthSection() is called
  // LINKS: UC-001, V-M-AUTH-UI
  // END_CONTRACT: constructor
  constructor(deps: AuthUIDeps) {
    this.deps = deps;
  }

  // START_CONTRACT: renderAuthSection
  // PURPOSE: render the auth UI into the given container and subscribe to AuthEvents
  // INPUTS: container: HTMLElement
  // OUTPUTS: AuthUIHandle — call unsubscribe() to detach
  // SIDE_EFFECTS: mutates container subtree; subscribes to AuthService
  // LINKS: UC-001, UC-002, UC-015, V-M-AUTH-UI
  // END_CONTRACT: renderAuthSection
  renderAuthSection(container: HTMLElement): AuthUIHandle {
    this.currentContainer = container;
    // START_BLOCK_SUBSCRIBE
    const unsub = this.deps.auth.subscribe(() => {
      // Any auth-event triggers a re-render to keep UI consistent with state.
      this._render();
    });
    // END_BLOCK_SUBSCRIBE

    this._render();

    return {
      unsubscribe: () => {
        try {
          unsub();
        } catch (err: unknown) {
          logWarn(
            "renderAuthSection",
            "AUTH_UI_UNSUB_ERR",
            "unsubscribe threw — swallowed",
            "UC-001",
            { err: err instanceof Error ? err.message : String(err) },
          );
        }
        this.currentContainer = null;
      },
      rerender: () => this._render(),
    };
  }

  private _render(): void {
    const container = this.currentContainer;
    if (!container) return;

    // START_BLOCK_RENDER
    container.empty();

    const { auth, i18n } = this.deps;
    const isReady = auth.isReady();

    // Section heading. Idempotent — `empty()` above wiped previous nodes.
    new Setting(container)
      .setName(i18n.t("auth.section.title"))
      .setDesc(i18n.t("auth.section.desc"))
      .setHeading();

    if (isReady) {
      this._renderConnected(container);
    } else {
      this._renderDisconnected(container);
    }
    // END_BLOCK_RENDER
  }

  private _renderConnected(container: HTMLElement): void {
    const { auth, i18n } = this.deps;
    const userId = auth.getUserId() ?? "";

    new Setting(container)
      .setName(i18n.t("auth.connected_as", { userId }))
      .addButton((btn) =>
        btn
          .setButtonText(i18n.t("auth.disconnect"))
          .setWarning()
          .onClick(() => {
            void this._handleDisconnect();
          }),
      );

    // After logout, the banner from any prior session-expired should clear
    // automatically since we always re-render on AuthEvent. No banner shown
    // here.
    this.currentBannerVisible = false;
  }

  private _renderDisconnected(container: HTMLElement): void {
    const { i18n } = this.deps;

    // START_BLOCK_RENDER_BANNER
    const sessionExpired = this._shouldShowBanner();
    if (sessionExpired) {
      const banner = container.createDiv({ cls: "readine-auth-banner mod-warning" });
      banner.textContent = i18n.t("auth.session_expired");
      this.currentBannerVisible = true;
      logInfo(
        "renderBanner",
        "SESSION_EXPIRED_BANNER_SHOWN",
        "re-auth banner rendered — session expired or stale token",
        "UC-015",
        {},
      );
    } else {
      this.currentBannerVisible = false;
    }
    // END_BLOCK_RENDER_BANNER

    let pasted = "";
    new Setting(container)
      .setName(i18n.t("auth.code.placeholder"))
      .setDesc(i18n.t("auth.code.desc"))
      .addText((input) =>
        input
          .setPlaceholder(i18n.t("auth.code.placeholder"))
          .onChange((value) => {
            pasted = value.trim();
          }),
      )
      .addButton((btn) =>
        btn
          .setButtonText(i18n.t("auth.connect"))
          .setCta()
          .onClick(() => {
            void this._handleConnect(pasted);
          }),
      );
  }

  private _shouldShowBanner(): boolean {
    // The banner shows when either (a) we just received a session-expired
    // event during this UI's lifetime, OR (b) the host (Settings UI) reports
    // a persisted `lastSyncError === 'session_expired'`.
    const flag = this.deps.hasSessionExpiredFlag;
    if (typeof flag === "function") {
      try {
        if (flag()) return true;
      } catch (err: unknown) {
        logWarn(
          "renderBanner",
          "AUTH_UI_FLAG_ERR",
          "hasSessionExpiredFlag probe threw",
          "UC-015",
          { err: err instanceof Error ? err.message : String(err) },
        );
      }
    }
    return false;
  }

  private _isLoggingIn = false;

  private async _handleConnect(code: string): Promise<void> {
    if (this._isLoggingIn) return;
    this._isLoggingIn = true;
    const { auth, i18n } = this.deps;
    const trimmed = typeof code === "string" ? code.trim() : "";
    if (trimmed.length === 0) {
      this._isLoggingIn = false;
      logWarn(
        "onConnect",
        "AUTH_UI_CONNECT",
        "empty code submitted — skipping login",
        "UC-001",
      );
      this.deps.onLoginOutcome?.({ ok: false, error: i18n.t("auth.empty_code") });
      return;
    }
    logInfo("onConnect", "AUTH_UI_CONNECT", "user submitted code", "UC-001", {
      codeLen: trimmed.length,
    });
    try {
      const result = await auth.login(trimmed);
      this.deps.onLoginOutcome?.({ ok: result.ok, userId: result.userId, error: result.error });
    } catch (err: unknown) {
      this._isLoggingIn = false;
      logWarn(
        "onConnect",
        "AUTH_UI_LOGIN_THREW",
        "AuthService.login rejected unexpectedly",
        "UC-001",
        { err: err instanceof Error ? err.message : String(err) },
      );
      this.deps.onLoginOutcome?.({
        ok: false,
        error: i18n.t("auth.error.network_error"),
      });
    } finally {
      this._isLoggingIn = false;
    }
  }

  private async _handleDisconnect(): Promise<void> {
    const { auth } = this.deps;
    try {
      await auth.logout();
      this.deps.onDisconnect?.();
      // Subscription will re-render on auth.disconnected.
    } catch (err: unknown) {
      logWarn(
        "onDisconnect",
        "AUTH_UI_LOGOUT_THREW",
        "AuthService.logout rejected unexpectedly",
        "UC-002",
        { err: err instanceof Error ? err.message : String(err) },
      );
    }
  }

  /** Test-only probe — was the banner element rendered on the last cycle? */
  __isBannerVisibleForTests(): boolean {
    return this.currentBannerVisible;
  }
}
// END_BLOCK_AUTH_UI

// START_CHANGE_SUMMARY
// LAST_CHANGE: 2026-05-13 — initial Phase 7 M-AUTH-UI implementation
// END_CHANGE_SUMMARY
