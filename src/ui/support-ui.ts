// START_MODULE_CONTRACT
// PURPOSE: Modal-based UI for UC-019. Renders a preview of the diagnostic bundle (editable text-area), then offers two actions: "Send" opens a mailto: link with the bundle URL-encoded into the body, and "Copy" pushes the bundle to navigator.clipboard.writeText. When the encoded bundle exceeds MAILTO_THRESHOLD, the Send button is supplemented with a hint recommending Copy + paste — many mail clients silently truncate long mailto: URLs.
// SCOPE: src/ui/support-ui.ts
// DEPENDS: M-SUPPORT-BUNDLE, M-I18N
// LINKS: UC-019, V-M-SUPPORT-UI
// ROLE: RUNTIME
// MAP_MODE: EXPORTS
// END_MODULE_CONTRACT

// START_MODULE_MAP
// SupportUI - facade owning the modal; .open() opens the modal
// SupportModal - inner Modal subclass with Send/Copy buttons + editable preview
// SupportUIDeps - DI bag for SupportUI (App + SupportBundle + I18n + optional Notice factory)
// SUPPORT_EMAIL - the destination address (consumed by mailto)
// MAILTO_THRESHOLD - encoded-bundle length above which we surface a length hint
// END_MODULE_MAP

import { App, Modal, Notice } from "obsidian";

import type { I18n } from "../i18n/i18n-bridge";
import type { SupportBundle } from "../support/support-bundle";

// START_BLOCK_CONSTANTS
export const SUPPORT_EMAIL = "support@readine.app";
/**
 * Most desktop mail clients silently truncate URLs over ~8K. We pick a safer
 * threshold and recommend Copy + paste above it. The serialized JSON of a
 * full 200-line log buffer typically lands ~50–80 KB, so most users will see
 * the hint — that's intentional.
 */
export const MAILTO_THRESHOLD = 4000;
// END_BLOCK_CONSTANTS

// START_BLOCK_TYPES
export interface SupportUIDeps {
  bundle: SupportBundle;
  i18n: I18n;
  /** Optional override for the email address (used by tests). */
  email?: string;
  /**
   * Optional override for the clipboard implementation. Tests can pass
   *   { writeText: vi.fn() }
   * to verify Copy without touching navigator.clipboard.
   */
  clipboard?: { writeText(text: string): Promise<void> };
  /**
   * Optional override for the open-url hook. Tests inject a spy; production
   * defaults to window.open(...) with target=_self.
   */
  openMailto?: (url: string) => void;
}
// END_BLOCK_TYPES

// START_BLOCK_INTERNAL_LOG
const MODULE_ID = "M-SUPPORT-UI";

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
    module: MODULE_ID,
    requirement: "UC-019",
    event,
    belief,
    ...details,
  });
}

function logWarn(
  anchor: string,
  event: string,
  belief: string,
  details: Record<string, unknown> = {},
): void {
  // eslint-disable-next-line no-console
  console.warn({
    ts: new Date().toISOString(),
    level: "warn",
    anchor,
    module: MODULE_ID,
    requirement: "UC-019",
    event,
    belief,
    ...details,
  });
}
// END_BLOCK_INTERNAL_LOG

// START_BLOCK_SUPPORT_MODAL
/**
 * The actual Obsidian Modal subclass. Exposed for tests / advanced consumers
 * that want to drive it directly. Most callers should go through
 * {@link SupportUI.open()}.
 */
export class SupportModal extends Modal {
  private readonly deps: SupportUIDeps;
  /** Latest preview text — owned by the textarea once rendered. */
  private currentText = "";

  constructor(app: App, deps: SupportUIDeps) {
    super(app);
    this.deps = deps;
  }

  // START_CONTRACT: onOpen
  // PURPOSE: render the bundle preview + Send/Copy/Cancel buttons
  // INPUTS: none (called by Modal.open())
  // OUTPUTS: void
  // SIDE_EFFECTS: mutates contentEl; emits SUPPORT_UI_OPEN log marker
  // LINKS: UC-019, V-M-SUPPORT-UI
  // END_CONTRACT: onOpen
  onOpen(): void {
    const { contentEl, deps } = this;
    const { i18n } = deps;

    // START_BLOCK_RENDER_PREVIEW
    contentEl.empty();
    this.setTitle(i18n.t("support.modal.title"));

    contentEl.createEl("p", { text: i18n.t("support.modal.desc") });

    const bundleData = deps.bundle.collectBundle();
    const serialized = deps.bundle.serialize(bundleData);
    this.currentText = serialized;

    contentEl.createEl("p", { text: i18n.t("support.modal.bundle.label"), cls: "readine-support-label" });
    const ta = contentEl.createEl("textarea") as unknown as HTMLTextAreaElement;
    ta.value = serialized;
    ta.readOnly = true;
    ta.className = "readine-support-textarea";
    // Store the serialized text for use by Send / Copy; it's never edited.
    this.currentText = serialized;

    if (serialized.length > MAILTO_THRESHOLD) {
      contentEl.createEl("p", {
        text: i18n.t("support.modal.large_bundle_hint"),
        cls: "readine-support-hint mod-warning",
      });
    }
    // END_BLOCK_RENDER_PREVIEW

    // START_BLOCK_RENDER_BUTTONS
    const row = contentEl.createDiv({ cls: "readine-support-buttons" });

    const sendBtn = row.createEl("button", {
      text: i18n.t("support.modal.send"),
      cls: "mod-cta",
    }) as unknown as HTMLButtonElement;
    sendBtn.addEventListener("click", () => {
      this._handleSend();
    });

    const copyBtn = row.createEl("button", {
      text: i18n.t("support.modal.copy"),
    }) as unknown as HTMLButtonElement;
    copyBtn.addEventListener("click", () => {
      void this._handleCopy();
    });

    const cancelBtn = row.createEl("button", {
      text: i18n.t("support.modal.cancel"),
    }) as unknown as HTMLButtonElement;
    cancelBtn.addEventListener("click", () => {
      this.close();
    });
    // END_BLOCK_RENDER_BUTTONS

    logInfo(
      "onOpen:BLOCK_RENDER_PREVIEW",
      "SUPPORT_UI_OPEN",
      "support modal opened — bundle preview rendered",
      {
        bytes: serialized.length,
        exceedsMailto: serialized.length > MAILTO_THRESHOLD,
      },
    );
  }

  private _handleSend(): void {
    // START_BLOCK_SEND
    const { i18n } = this.deps;
    const email = this.deps.email ?? SUPPORT_EMAIL;
    const subject = encodeURIComponent("Readine Obsidian Plugin Support");
    const body = encodeURIComponent(this.currentText);
    const url = `mailto:${email}?subject=${subject}&body=${body}`;

    try {
      if (this.deps.openMailto) {
        this.deps.openMailto(url);
      } else if (typeof window !== "undefined" && typeof window.open === "function") {
        window.open(url, "_self");
      } else {
        // No way to open a URL — fall back to copying so the user has *something*.
        logWarn(
          "onSend:BLOCK_SEND",
          "SUPPORT_UI_SEND_NO_WINDOW",
          "window.open unavailable — falling back to clipboard",
        );
        void this._handleCopy();
        return;
      }
      logInfo("onSend:BLOCK_SEND", "SUPPORT_UI_SEND", "mailto: opened", {
        bytes: this.currentText.length,
      });
      void i18n; // referenced for parity with localized notifications elsewhere
    } catch (err: unknown) {
      logWarn(
        "onSend:BLOCK_SEND",
        "SUPPORT_UI_SEND_FAIL",
        "mailto: failed — user notified via fallback path",
        { err: err instanceof Error ? err.message : String(err) },
      );
    }
    // END_BLOCK_SEND
  }

  private async _handleCopy(): Promise<void> {
    // START_BLOCK_COPY
    const { i18n } = this.deps;
    const clip = this.deps.clipboard ??
      (typeof navigator !== "undefined" ? navigator.clipboard : undefined);
    if (!clip || typeof clip.writeText !== "function") {
      logWarn(
        "onCopy:BLOCK_COPY",
        "SUPPORT_UI_COPY_NO_CLIPBOARD",
        "navigator.clipboard unavailable — user must select manually",
      );
      new Notice(i18n.t("support.copy_failed"));
      return;
    }
    try {
      await clip.writeText(this.currentText);
      logInfo("onCopy:BLOCK_COPY", "SUPPORT_UI_COPY", "bundle copied to clipboard", {
        bytes: this.currentText.length,
      });
      new Notice(i18n.t("support.copied"));
    } catch (err: unknown) {
      logWarn(
        "onCopy:BLOCK_COPY",
        "SUPPORT_UI_COPY_FAIL",
        "clipboard.writeText rejected",
        { err: err instanceof Error ? err.message : String(err) },
      );
      new Notice(i18n.t("support.copy_failed"));
    }
    // END_BLOCK_COPY
  }

  onClose(): void {
    this.contentEl.empty();
  }

  /** Test-only — read the current preview text without going through the textarea. */
  __getCurrentTextForTests(): string {
    return this.currentText;
  }

  /** Test-only — drive Send / Copy from a unit test. */
  __triggerSendForTests(): void {
    this._handleSend();
  }

  __triggerCopyForTests(): Promise<void> {
    return this._handleCopy();
  }
}
// END_BLOCK_SUPPORT_MODAL

// START_BLOCK_SUPPORT_UI
/**
 * Facade around SupportModal. Owns the App reference and exposes a single
 * imperative `open()` entry point used by Settings UI / Command palette.
 */
export class SupportUI {
  private readonly app: App;
  private readonly deps: SupportUIDeps;

  // START_CONTRACT: constructor
  // PURPOSE: build a SupportUI bound to an App + bundle assembler
  // INPUTS: app: App, deps: SupportUIDeps
  // OUTPUTS: instance
  // SIDE_EFFECTS: none
  // LINKS: UC-019, V-M-SUPPORT-UI
  // END_CONTRACT: constructor
  constructor(app: App, deps: SupportUIDeps) {
    this.app = app;
    this.deps = deps;
  }

  // START_CONTRACT: open
  // PURPOSE: open the support modal
  // INPUTS: none
  // OUTPUTS: SupportModal — returned for advanced callers (tests); the modal is already open
  // SIDE_EFFECTS: mounts the modal into the App
  // LINKS: UC-019, V-M-SUPPORT-UI
  // END_CONTRACT: open
  open(): SupportModal {
    const modal = new SupportModal(this.app, this.deps);
    modal.open();
    return modal;
  }
}
// END_BLOCK_SUPPORT_UI

// START_CHANGE_SUMMARY
// LAST_CHANGE: 2026-05-13 — initial Phase 7 M-SUPPORT-UI implementation
// LAST_CHANGE: 2026-06-04 — make textarea readonly with resize:none; store currentText as readonly snapshot
// LAST_CHANGE: 2026-06-04 — textarea on own line with CSS class readine-support-textarea; buttons use flex gap via CSS
// END_CHANGE_SUMMARY
