// START_MODULE_CONTRACT
// PURPOSE: Top-level PluginSettingTab. Shows a three-state wizard: Step 1 (unauthed → auth code), Step 2 (authed, first sync → path + format + Start sync), Step 3 (synced → full config + notifications list + sync progress bar). After successful sync the full UI is shown. Disconnect returns to Step 1. Subscribes to orchestrator.progress$ to display real-time sync status.
// SCOPE: src/ui/settings-ui.ts
// DEPENDS: M-SETTINGS-MANAGER, M-I18N, M-SYNC-ORCHESTRATOR, M-AUTH-UI, M-SUPPORT-UI, M-NOTIFICATIONS
// LINKS: UC-001, UC-003, UC-005, UC-006, UC-007, UC-008, UC-009, UC-011, UC-019, UC-020, UC-022, V-M-SETTINGS-UI
// ROLE: RUNTIME
// MAP_MODE: EXPORTS
// END_MODULE_CONTRACT

// START_MODULE_MAP
// ReadineSettingTab - extends PluginSettingTab; .display() renders the full surface
// SettingsUIDeps - DI bag wiring auth/settings/i18n/orchestrator/support
// SUPPORTED_UI_LANGUAGES - exported [code, nativeName] table for the language dropdown
// END_MODULE_MAP

import { App, AbstractInputSuggest, Notice, Plugin, PluginSettingTab, Setting } from "obsidian";
import { Subscription, throttleTime } from "rxjs";

import type { SettingsKey, SettingsManager, SettingsSnapshot } from "../settings/settings-manager";
import type { I18n } from "../i18n/i18n-bridge";
import type { LangCode } from "../i18n/i18n";
import { setLanguage } from "../i18n/i18n";
import type { SyncOrchestrator, SyncProgressEvent } from "../sync/sync-orchestrator";
import type { AuthUI } from "./auth-ui";
import type { SupportUI } from "./support-ui";
import type { NotificationsStore } from "../notifications/notifications-store";

// START_BLOCK_TYPES
export interface SettingsUIDeps {
  settings: SettingsManager;
  i18n: I18n;
  orchestrator: SyncOrchestrator;
  authUI: AuthUI;
  supportUI: SupportUI;
  notificationsStore: NotificationsStore;
}

/**
 * Table of supported UI languages with native names. Static — used to populate
 * the language dropdown. Order mirrors the M-I18N SUPPORTED_LANGUAGES export.
 */
export const SUPPORTED_UI_LANGUAGES: ReadonlyArray<readonly [LangCode, string]> = [
  ["en", "English"],
  ["ru", "Русский"],
  ["de", "Deutsch"],
  ["fr", "Français"],
  ["ja", "日本語"],
  ["pt", "Português"],
  ["es", "Español"],
  ["zh", "中文"],
  ["it", "Italiano"],
  ["ko", "한국어"],
] as const;

import { DEFAULT_FILE_TEMPLATE } from "../constants";

const DEFAULT_PATH_TEMPLATE = "Readine/{feedName}/{yyyy}-{mm}/{title}.md";

// ────────────── VaultFolderSuggest (autocomplete for Path template) ──────────────

const TEMPLATE_TOKENS = [
  "{feedName}",
  "{feedId}",
  "{yyyy}",
  "{mm}",
  "{dd}",
  "{title}",
  "{articleId}",
] as const;

class VaultFolderSuggest extends AbstractInputSuggest<string> {
  private folders: string[];
  private _inputEl: HTMLInputElement;

  constructor(app: App, inputEl: HTMLInputElement) {
    super(app, inputEl);
    this._inputEl = inputEl;
    this.folders = this._collectFolders(app);
    this.limit = 50;
  }

  private _collectFolders(app: App): string[] {
    const set = new Set<string>();
    const folders = app.vault.getAllFolders?.() ?? [];
    for (const f of folders) {
      if (!f.isRoot()) set.add(f.path);
    }
    return [...set].sort((a, b) => a.localeCompare(b));
  }

  getSuggestions(query: string): string[] {
    const segments = query.split("/");
    const currentSegment = segments[segments.length - 1] ?? "";
    const basePath = segments.length > 1
      ? segments.slice(0, -1).join("/") + "/"
      : "";

    const lowerSegment = currentSegment.toLowerCase();
    const results: string[] = [];

    // Template tokens — show when typing inside { }
    if (currentSegment.startsWith("{")) {
      for (const token of TEMPLATE_TOKENS) {
        if (token.toLowerCase().includes(lowerSegment)) {
          results.push(token);
        }
      }
      return results.slice(0, this.limit);
    }

    // Folder next-segment matches
    const uniqueSegments = new Set<string>();
    for (const folder of this.folders) {
      if (!folder.startsWith(basePath)) continue;
      const remaining = folder.slice(basePath.length);
      if (!remaining) continue;

      const nextSlash = remaining.indexOf("/");
      const segment = nextSlash >= 0
        ? remaining.slice(0, nextSlash + 1)
        : remaining;

      if (segment.toLowerCase().startsWith(lowerSegment)) {
        uniqueSegments.add(segment);
      }
    }

    results.push(
      ...[...uniqueSegments]
        .sort((a, b) => a.localeCompare(b))
        .map((s) => basePath + s),
    );

    // Matching tokens
    for (const token of TEMPLATE_TOKENS) {
      if (token.toLowerCase().includes(lowerSegment)) {
        results.push(token);
      }
    }

    return results.slice(0, this.limit);
  }

  renderSuggestion(value: string, el: HTMLElement): void {
    el.setText(value);
    if (value.startsWith("{")) {
      el.setCssStyles({ opacity: "0.65", fontStyle: "italic" });
    }
  }

  selectSuggestion(value: string, _evt: MouseEvent | KeyboardEvent): void {
    const inputEl = this._inputEl;
    const cursorPos = inputEl.selectionStart ?? inputEl.value.length;
    const currentVal = this.getValue();
    const textBeforeCursor = currentVal.slice(0, cursorPos);
    const textAfterCursor = currentVal.slice(cursorPos);

    // Find segment start (after last / before cursor)
    const lastSlash = textBeforeCursor.lastIndexOf("/");
    const segmentStart = lastSlash >= 0 ? lastSlash + 1 : 0;

    // Strip base path prefix from value if present
    const basePath = currentVal.slice(0, segmentStart);
    let insertValue = value;
    if (value.startsWith(basePath)) {
      insertValue = value.slice(basePath.length);
    }

    const newVal =
      textBeforeCursor.slice(0, segmentStart) + insertValue + textAfterCursor;
    this.setValue(newVal);
    this.close();

    inputEl.dispatchEvent(new Event("input", { bubbles: true }));

    setTimeout(() => {
      inputEl.focus();
      const pos = segmentStart + insertValue.length;
      inputEl.selectionStart = inputEl.selectionEnd = pos;
    }, 0);
  }
}
// END_BLOCK_TYPES

// START_BLOCK_INTERNAL_LOG
const MODULE_ID = "M-SETTINGS-UI";

function logInfo(
  anchor: string,
  event: string,
  belief: string,
  requirement: string,
  details: Record<string, unknown> = {},
): void {
  console.debug({
    ts: new Date().toISOString(),
    level: "debug",
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

// START_BLOCK_SETTINGS_TAB
/**
 * Top-level Settings Tab. Constructed once per plugin instance during
 * M-PLUGIN-MAIN.onload() and registered via `plugin.addSettingTab(this)`.
 * Obsidian invokes `display()` whenever the tab becomes active.
 *
 * Lifecycle:
 *
 *   const tab = new ReadineSettingTab(app, plugin, { settings, i18n, ... });
 *   plugin.addSettingTab(tab);
 *   // ... Obsidian calls display() when the tab opens
 *   // ... on language switch, display() is re-invoked to refresh translations
 */
export class ReadineSettingTab extends PluginSettingTab {
  private readonly deps: SettingsUIDeps;
  private authUIHandle: { unsubscribe(): void; rerender(): void } | null = null;
  private _progressSub: Subscription | null = null;
  private _progressEl: HTMLElement | null = null;
  private _progressBarEl: HTMLElement | null = null;
  private _progressTextEl: HTMLElement | null = null;

  // START_CONTRACT: constructor
  // PURPOSE: build the Settings Tab bound to its DI bag
  // INPUTS: app: App, plugin: Plugin, deps: SettingsUIDeps
  // OUTPUTS: instance; not yet rendered
  // SIDE_EFFECTS: none until display() is called
  // LINKS: UC-005, V-M-SETTINGS-UI
  // END_CONTRACT: constructor
  constructor(app: App, plugin: Plugin, deps: SettingsUIDeps) {
    super(app, plugin);
    this.deps = deps;
  }

  // START_CONTRACT: display
  // PURPOSE: render the settings surface — three-state wizard depending on auth + first-sync
  // INPUTS: none
  // OUTPUTS: void
  // SIDE_EFFECTS: empties containerEl; mounts sub-sections; subscribes to AuthService
  // LINKS: UC-001, UC-003, UC-005, UC-006, UC-007, UC-008, UC-009, UC-011, UC-019, UC-020, UC-022, V-M-SETTINGS-UI
  // END_CONTRACT: display
  display(): void {
    const { containerEl } = this;
    const { i18n, authUI, settings, notificationsStore } = this.deps;

    // START_BLOCK_TEARDOWN
    if (this.authUIHandle) {
      try { this.authUIHandle.unsubscribe(); } catch { /* swallow */ }
      this.authUIHandle = null;
    }
    this._teardownProgress();
    containerEl.empty();
    // END_BLOCK_TEARDOWN

    // START_BLOCK_SYNC_PROGRESS
    this._renderProgress(containerEl);
    // END_BLOCK_SYNC_PROGRESS

    // START_BLOCK_AUTH
    const authContainer = containerEl.createDiv({ cls: "readine-auth-container" });
    this.authUIHandle = authUI.renderAuthSection(authContainer);

    if (settings.get("sessionId") === null) {
      // Step 1 — only auth code input, everything else hidden
      return;
    }
    // END_BLOCK_AUTH

    // START_BLOCK_WIZARD_STEP2
    // Step 2 — wizard: configure path + format before first sync
    logInfo("display:BLOCK_WIZARD_STEP2",
        "DEBUG_DISPLAY_WIZARD",
        "display wizard check",
        "UC-001",
        { hasSessionId: settings.get("sessionId") !== null,
          wizardCompleted: settings.get("wizardCompleted"),
          containerChildren: containerEl.children.length });
    if (!settings.get("wizardCompleted")) {
      this._renderWizardStep2(containerEl);
      return;
    }
    // END_BLOCK_WIZARD_STEP2

    // START_BLOCK_ACTIONS
    new Setting(containerEl)
      .setName(i18n.t("settings.actions.title"))
      .setHeading();

    new Setting(containerEl)
      .setName(i18n.t("settings.actions.sync_now"))
      .setDesc(i18n.t("settings.actions.sync_now.desc"))
      .addButton((btn) =>
        btn
          .setButtonText(i18n.t("settings.actions.sync_now"))
          .setCta()
          .onClick(() => void this._handleSyncNow()),
      );

    new Setting(containerEl)
      .setName(i18n.t("settings.actions.open_support"))
      .setDesc(i18n.t("settings.actions.open_support.desc"))
      .addButton((btn) =>
        btn
          .setButtonText(i18n.t("settings.actions.open_support"))
          .onClick(() => this._handleOpenSupport()),
      );
    // END_BLOCK_ACTIONS

    // START_BLOCK_FULL_UI
    // Step 3 — full settings after first successful sync
    new Setting(containerEl)
      .setName(i18n.t("settings.section.title"))
      .setDesc(i18n.t("settings.section.desc"))
      .setHeading();

    this._renderOutputFormat(containerEl);
    this._renderPathTemplate(containerEl);
    this._renderDeletePolicy(containerEl);
    this._renderAutoSyncInterval(containerEl);
    this._renderNetworkForArticles(containerEl);
    this._renderLimitCacheDays(containerEl);
    this._renderCleanupExcludeFavorites(containerEl);
    this._renderCleanupExcludeWithNotes(containerEl);
    this._renderUiLanguage(containerEl);
    this._renderNotificationsBadge(containerEl);
    if (settings.get("outputFormat") === "markdown") {
      this._renderFileTemplate(containerEl);
    }
    this._renderSyncFavoritesOnly(containerEl);
    // END_BLOCK_FULL_UI

    // START_BLOCK_NOTIFICATIONS
    const notifications = notificationsStore.getNotifications();


    const hasActive = notifications.length > 0 || notificationsStore.getUnreadCount() > 0;

    if (hasActive) {
      new Setting(containerEl)
        .setName(i18n.t("notifications.title"))
        .setHeading();

      if (notificationsStore.getUnreadCount() > 0) {
        new Setting(containerEl)
          .setName(i18n.t("notifications.mark_all_read"))
          .addButton((btn) =>
            btn
              .setButtonText(i18n.t("notifications.mark_read"))
              .onClick(() => {
                notificationsStore.markAllAsRead();
                this.display();
              }),
          );
      }

      for (const n of notifications) {
        const s = new Setting(containerEl)
          .setDesc(n.message ?? "")
          .setClass(n.wasRead ? "readine-notification-read" : "readine-notification-unread");

        if (n.createdUtc) {
          s.setName(
            n.createdUtc.toLocaleDateString(undefined, {
              year: "numeric",
              month: "short",
              day: "numeric",
              hour: "2-digit",
              minute: "2-digit",
            }),
          );
        }

        if (!n.wasRead) {
          s.addButton((btn) =>
            btn
              .setButtonText(i18n.t("notifications.mark_read"))
              .onClick(() => {
                notificationsStore.markAsRead(n.notificationId);
                this.display();
              }),
          );
        }
      }
    } else {
      new Setting(containerEl)
        .setName(i18n.t("notifications.title"))
        .setHeading();

      const latest3 = notifications
          .filter((n) => !n.isDeleted)
          .sort((a, b) => (b.createdUtc?.getTime() ?? 0) - (a.createdUtc?.getTime() ?? 0))
          .slice(0, 3);

      if (latest3.length === 0) {
        containerEl.createEl("p", {
          text: i18n.t("notifications.empty") ?? "No notifications yet.",
          cls: "readine-notifications-empty",
        });
      } else {
        for (const n of latest3) {
          const s = new Setting(containerEl)
            .setDesc(n.message ?? "")
            .setClass("readine-notification-read");

          if (n.createdUtc) {
            s.setName(
              n.createdUtc.toLocaleDateString(undefined, {
                year: "numeric",
                month: "short",
                day: "numeric",
                hour: "2-digit",
                minute: "2-digit",
              }),
            );
          }
        }
      }
    }
    // END_BLOCK_NOTIFICATIONS

    logInfo(
      "display",
      "SETTINGS_UI_RENDERED",
      "settings tab rendered with full UI",
      "UC-005",
      { language: i18n.getCurrentLanguage() },
    );
  }

  hide(): void {
    if (this.authUIHandle) {
      try { this.authUIHandle.unsubscribe(); } catch { /* swallow */ }
      this.authUIHandle = null;
    }
    this._teardownProgress();
  }

  // ────────────── Sync progress bar ──────────────

  private _renderProgress(container: HTMLElement): void {
    // Create progress container — hidden by default, shown on first event.
    this._progressEl = container.createDiv({ cls: "readine-sync-progress" });
    this._progressBarEl = this._progressEl.createDiv({ cls: "readine-sync-progress-bar", attr: { style: "width:0%" } });
    this._progressTextEl = this._progressEl.createDiv({ cls: "readine-sync-progress-text" });
    this._progressEl.setCssStyles({ display: "none" });

    // Subscribe to orchestrator progress events.
    const { i18n } = this.deps;
    this._progressSub = this.deps.orchestrator.progress$
      .pipe(throttleTime(200, undefined, { leading: true, trailing: true }))
      .subscribe((event: SyncProgressEvent) => {
        this._updateProgress(event, i18n);
      });
  }

  private _updateProgress(event: SyncProgressEvent, i18n: I18n): void {
    if (!this._progressEl || !this._progressTextEl) return;

    this._progressEl.setCssStyles({ display: "block" });

    // Translate the message key.
    this._progressTextEl.textContent = i18n.t(event.messageKey, event.params);

    // Update progress bar width based on phase.
    let pct = 0;
    switch (event.phase) {
      case "auth_check": pct = 5; break;
      case "network_check": pct = 10; break;
      case "fetch_delta": pct = 20; break;
      case "crash_recovery": pct = 15; break;
      case "load_batch": {
        if (event.params?.current && event.params?.total) {
          pct = 25 + (Number(event.params.current) / Number(event.params.total)) * 25;
        } else {
          pct = 35;
        }
        break;
      }
      case "download_write": {
        if (event.params?.written && event.params?.total) {
          const total = Number(event.params.total);
          pct = 50 + (total > 0 ? (Number(event.params.written) / total) * 35 : 0);
        } else {
          pct = 65;
        }
        break;
      }
      case "delete_policy": pct = 88; break;
      case "cache_cleanup": pct = 93; break;
      case "complete": pct = 100; break;
      case "failed": pct = 100; break;
    }

    if (this._progressBarEl) {
      this._progressBarEl.setCssStyles({ width: `${pct}%` });
    }

    if (event.phase === "complete" || event.phase === "failed") {
      this._progressEl.addClass("readine-sync-progress-done");
    }
  }

  private _teardownProgress(): void {
    if (this._progressSub) {
      this._progressSub.unsubscribe();
      this._progressSub = null;
    }
    this._progressEl = null;
    this._progressBarEl = null;
    this._progressTextEl = null;
  }

  // ────────────── Widget renderers ──────────────

  // START_BLOCK_WIZARD_STEP2_RENDER
  private _renderWizardStep2(container: HTMLElement): void {
    logInfo("_renderWizardStep2",
        "DEBUG_RENDER_WIZARD_STEP2",
        "_renderWizardStep2 called",
        "UC-001", { containerChildren: container.children.length });
    const { settings, i18n } = this.deps;
    new Setting(container)
      .setName(i18n.t("settings.wizard.title"))
      .setDesc(i18n.t("settings.wizard.desc"))
      .setHeading();

    this._renderOutputFormat(container);
    this._renderPathTemplate(container);
    if (settings.get("outputFormat") === "markdown") {
      this._renderFileTemplate(container);
    }
    this._renderSyncFavoritesOnly(container);

    new Setting(container).addButton((btn) =>
      btn
        .setButtonText(i18n.t("settings.wizard.complete"))
        .setCta()
        .onClick(async () => {
          await settings.set("wizardCompleted", true);
          this.display();
        }),
    );
  }
  // END_BLOCK_WIZARD_STEP2_RENDER

  private _renderOutputFormat(container: HTMLElement): void {
    const { settings, i18n } = this.deps;
    new Setting(container)
      .setName(i18n.t("settings.output_format.title"))
      .setDesc(i18n.t("settings.output_format.desc"))
      .addDropdown((d) => {
        d.addOption("markdown", i18n.t("settings.output_format.markdown"))
          .addOption("html", i18n.t("settings.output_format.html"))
          .setValue(settings.get("outputFormat"))
          .onChange((value) => {
            const persist1 = this._persist(
              "outputFormat",
              value as SettingsSnapshot["outputFormat"],
            );
            // Auto-update path template extension
            const currentTemplate = settings.get("pathTemplate");
            const newTemplate =
              value === "markdown"
                ? currentTemplate.replace(/\.html$/i, ".md")
                : currentTemplate.replace(/\.md$/i, ".html");
            const persist2 =
              newTemplate !== currentTemplate
                ? this._persist("pathTemplate", newTemplate)
                : Promise.resolve();
            // Re-render after both persists complete
            Promise.all([persist1, persist2]).then(() => this.display());
          });
      });
  }

  private _renderPathTemplate(container: HTMLElement): void {
    const { settings, i18n } = this.deps;

    // Row 1: name + description + restore button
    new Setting(container)
      .setName(i18n.t("settings.path_template.title"))
      .setDesc(i18n.t("settings.path_template.desc"))
      .addButton((btn) =>
        btn
          .setButtonText(i18n.t("settings.path_template.restore"))
          .onClick(() => {
            const tpl =
              settings.get("outputFormat") === "markdown"
                ? DEFAULT_PATH_TEMPLATE
                : DEFAULT_PATH_TEMPLATE.replace(/\.md$/, ".html");
            void this._persist("pathTemplate", tpl).then(() => {
              this.display();
            });
          }),
      );

    // Row 2: full-width input
    let textInputEl: HTMLInputElement | null = null;
    const row = new Setting(container);
    if (row.infoEl) row.infoEl.setCssStyles({ display: "none" });
    if (row.controlEl) row.controlEl.setCssStyles({ width: "100%" });

    row.addText((input) => {
      textInputEl = input.inputEl;
      input
        .setValue(settings.get("pathTemplate"))
        .onChange((value) => {
          void this._persist("pathTemplate", value);
        });
    });

    const inputEl = textInputEl! as HTMLInputElement;
    inputEl.setCssStyles({ flex: "1 1 auto", minWidth: "150px" });
    new VaultFolderSuggest(this.app, inputEl);
  }

  private _renderDeletePolicy(container: HTMLElement): void {
    const { settings, i18n } = this.deps;
    new Setting(container)
      .setName(i18n.t("settings.delete_policy.title"))
      .setDesc(i18n.t("settings.delete_policy.desc"))
      .addDropdown((d) => {
        d.addOption("keep", i18n.t("settings.delete_policy.keep"))
          .addOption("delete", i18n.t("settings.delete_policy.delete"))
          .setValue(settings.get("deletePolicy"))
          .onChange((value) => {
            void this._persist(
              "deletePolicy",
              value as SettingsSnapshot["deletePolicy"],
            );
          });
      });
  }

  private _renderAutoSyncInterval(container: HTMLElement): void {
    const { settings, i18n } = this.deps;
    new Setting(container)
      .setName(i18n.t("settings.auto_sync_interval.title"))
      .setDesc(i18n.t("settings.auto_sync_interval.desc"))
      .addDropdown((d) => {
        d.addOption("off", i18n.t("settings.auto_sync_interval.off"))
          .addOption("5", i18n.t("settings.auto_sync_interval.5"))
          .addOption("15", i18n.t("settings.auto_sync_interval.15"))
          .addOption("30", i18n.t("settings.auto_sync_interval.30"))
          .addOption("60", i18n.t("settings.auto_sync_interval.60"))
          .addOption("240", i18n.t("settings.auto_sync_interval.240"))
          .addOption("480", i18n.t("settings.auto_sync_interval.480"))
          .addOption("1440", i18n.t("settings.auto_sync_interval.1440"))
          .setValue(String(settings.get("autoSyncInterval")))
          .onChange((value) => {
            const next: SettingsSnapshot["autoSyncInterval"] =
              value === "off" ? "off" : (Number(value) as 5 | 15 | 30 | 60 | 240 | 480 | 1440);
            void this._persist("autoSyncInterval", next);
          });
      });
  }

  private _renderNetworkForArticles(container: HTMLElement): void {
    const { settings, i18n } = this.deps;
    new Setting(container)
      .setName(i18n.t("settings.network_for_articles.title"))
      .setDesc(i18n.t("settings.network_for_articles.desc"))
      .addDropdown((d) => {
        d.addOption("always", i18n.t("settings.network_for_articles.always"))
          .addOption("Wi-Fi+cellular", i18n.t("settings.network_for_articles.wifi_cellular"))
          .addOption("Wi-Fi-only", i18n.t("settings.network_for_articles.wifi_only"))
          .addOption("off", i18n.t("settings.network_for_articles.off"))
          .setValue(settings.get("networkForArticles"))
          .onChange((value) => {
            void this._persist(
              "networkForArticles",
              value as SettingsSnapshot["networkForArticles"],
            );
          });
      });
  }

  private _renderLimitCacheDays(container: HTMLElement): void {
    const { settings, i18n } = this.deps;
    new Setting(container)
      .setName(i18n.t("settings.limit_cache_days.title"))
      .setDesc(i18n.t("settings.limit_cache_days.desc"))
      .addDropdown((d) => {
        d.addOption("off", i18n.t("settings.limit_cache_days.off"))
          .addOption("7", i18n.t("settings.limit_cache_days.7"))
          .addOption("30", i18n.t("settings.limit_cache_days.30"))
          .addOption("90", i18n.t("settings.limit_cache_days.90"))
          .addOption("365", i18n.t("settings.limit_cache_days.365"))
          .setValue(String(settings.get("limitCacheDays")))
          .onChange((value) => {
            const next: SettingsSnapshot["limitCacheDays"] =
              value === "off" ? "off" : (Number(value) as 7 | 30 | 90 | 365);
            void this._persist("limitCacheDays", next);
          });
      });
  }

  private _renderUiLanguage(container: HTMLElement): void {
    const { settings, i18n } = this.deps;
    new Setting(container)
      .setName(i18n.t("settings.ui_language.title"))
      .setDesc(i18n.t("settings.ui_language.desc"))
      .addDropdown((d) => {
        for (const [code, label] of SUPPORTED_UI_LANGUAGES) {
          d.addOption(code, label);
        }
        d.setValue(i18n.getCurrentLanguage()).onChange((value) => {
          const lang = value as LangCode;
          void this._handleLanguageChange(lang);
        });
      });
  }

  private _renderNotificationsBadge(container: HTMLElement): void {
    const { settings, i18n } = this.deps;
    new Setting(container)
      .setName(i18n.t("settings.notifications_badge.title"))
      .setDesc(i18n.t("settings.notifications_badge.desc"))
      .addToggle((toggle) =>
        toggle
          .setValue(settings.get("notificationsBadge"))
          .onChange((value) => {
            void this._persist("notificationsBadge", value);
          }),
      );
  }

  private _renderSyncFavoritesOnly(container: HTMLElement): void {
    const { settings, i18n } = this.deps;
    new Setting(container)
      .setName(i18n.t("settings.sync_favorites_only.title") || "Sync favorites only")
      .setDesc(i18n.t("settings.sync_favorites_only.desc") || "Only sync articles you've starred in Readine")
      .addToggle((t) => {
        t.setValue(settings.get("syncFavoritesOnly"))
          .onChange((value) => {
            void this._persist("syncFavoritesOnly", value);
          });
      });
  }

  private _renderCleanupExcludeFavorites(container: HTMLElement): void {
    const { settings, i18n } = this.deps;
    new Setting(container)
      .setName(i18n.t("settings.cleanup_exclude_favorites.title") || "Skip favorited")
      .setDesc(i18n.t("settings.cleanup_exclude_favorites.desc") || "Don't delete favorited articles during cache cleanup or server-side removal")
      .addToggle((t) => {
        t.setValue(settings.get("cleanupExcludeFavorites"))
          .onChange((value) => void this._persist("cleanupExcludeFavorites", value));
      });
  }

  private _renderCleanupExcludeWithNotes(container: HTMLElement): void {
    const { settings, i18n } = this.deps;
    new Setting(container)
      .setName(i18n.t("settings.cleanup_exclude_notes.title") || "Skip with notes")
      .setDesc(i18n.t("settings.cleanup_exclude_notes.desc") || "Don't delete articles with notes during cache cleanup or server-side removal")
      .addToggle((t) => {
        t.setValue(settings.get("cleanupExcludeWithNotes"))
          .onChange((value) => void this._persist("cleanupExcludeWithNotes", value));
      });
  }

  private _renderFileTemplate(container: HTMLElement): void {
    const { settings, i18n } = this.deps;
    // Row 1: name + description + restore button
    new Setting(container)
      .setName(i18n.t("settings.file_template.title") || "Article template")
      .setDesc(i18n.t("settings.file_template.desc") || "Template for markdown articles. Tokens: {{title}}, {{date}}, {{url}}, {{tags}}, {{feedName}}, {{feedId}}, {{id}}, {{notes}}, {{text}}.")
      .addButton((btn) =>
        btn
          .setButtonText(i18n.t("settings.file_template.restore") || "Restore default")
          .onClick(() => {
            void this._persist("fileTemplate", DEFAULT_FILE_TEMPLATE).then(() => {
              this.display();
            });
          }),
      );

    // Row 2: full-width textarea (no resize)
    const row = new Setting(container);
    if (row.infoEl) row.infoEl.setCssStyles({ display: "none" });
    if (row.controlEl) row.controlEl.setCssStyles({ width: "100%" });

    row.addTextArea((input) => {
      input.inputEl.setCssStyles({ width: "100%", resize: "none", minHeight: "120px" });
      input
        .setValue(settings.get("fileTemplate"))
        .onChange((value) => {
          void this._persist("fileTemplate", value);
        });
    });
  }

  // ────────────── Action handlers ──────────────

  private async _persist<K extends SettingsKey>(
    key: K,
    value: SettingsSnapshot[K],
  ): Promise<void> {
    try {
      await this.deps.settings.set(key, value);
    } catch (err: unknown) {
      logWarn(
        "persist",
        "SETTINGS_UI_PERSIST_FAIL",
        "settings.set rejected",
        "UC-005",
        { key, err: err instanceof Error ? err.message : String(err) },
      );
    }
  }

  private async _handleLanguageChange(lang: LangCode): Promise<void> {
    // START_BLOCK_LANGUAGE_CHANGE
    try {
      await setLanguage(lang, (l) => {
        void this.deps.settings.set("uiLanguageSet", true);
        void this.deps.settings.set("uiLanguage", l);
      });
      logInfo(
        "languageChange",
        "SETTINGS_UI_LANG_CHANGED",
        "active UI language switched — re-rendering tab",
        "UC-020",
        { lang },
      );
      // Re-render so labels reflect the new language.
      this.display();
    } catch (err: unknown) {
      logWarn(
        "languageChange",
        "SETTINGS_UI_LANG_FAIL",
        "language switch failed",
        "UC-020",
        { lang, err: err instanceof Error ? err.message : String(err) },
      );
    }
    // END_BLOCK_LANGUAGE_CHANGE
  }

  private async _handleSyncNow(): Promise<void> {
    // START_BLOCK_SYNC_NOW
    const { orchestrator, i18n } = this.deps;
    logInfo(
      "syncNow",
      "SETTINGS_UI_SYNC_NOW",
      "user triggered manual sync from settings",
      "UC-003",
      {},
    );
    try {
      new Notice(i18n.t("notice.sync_started"));
      const r = await orchestrator.triggerSync("manual");
      if (!r.success && r.error === "no_auth") {
        new Notice(i18n.t("notice.sync_no_auth"));
      }
    } catch (err: unknown) {
      logWarn(
        "syncNow",
        "SETTINGS_UI_SYNC_THREW",
        "triggerSync rejected unexpectedly",
        "UC-003",
        { err: err instanceof Error ? err.message : String(err) },
      );
    }
    // END_BLOCK_SYNC_NOW
  }

  private _handleOpenSupport(): void {
    // START_BLOCK_OPEN_SUPPORT
    logInfo(
      "openSupport",
      "SETTINGS_UI_OPEN_SUPPORT",
      "user opened the support modal",
      "UC-019",
      {},
    );
    try {
      this.deps.supportUI.open();
    } catch (err: unknown) {
      logWarn(
        "openSupport",
        "SETTINGS_UI_SUPPORT_THREW",
        "supportUI.open() rejected unexpectedly",
        "UC-019",
        { err: err instanceof Error ? err.message : String(err) },
      );
    }
    // END_BLOCK_OPEN_SUPPORT
  }
}
// END_BLOCK_SETTINGS_TAB

// START_CHANGE_SUMMARY
// LAST_CHANGE: 2026-06-01 — add fileTemplate + htmlFileTemplate textarea renderers
// LAST_CHANGE: 2026-06-01 — logInfo: console.info → console.debug
// LAST_CHANGE: 2026-06-01 — expand cleanupExcludeFavorites/WithNotes descriptions to mention server-side removal
// LAST_CHANGE: 2026-06-02 — subscribe to orchestrator.progress$; render sync progress bar at top of settings
// LAST_CHANGE: 2026-06-03 — fileTemplate/htmlFileTemplate conditional on outputFormat; remove downloadAttachments/attachmentsOverridePath; textarea full-width new line with resize:none; fix i18n output_format keys for all 10 languages
// LAST_CHANGE: 2026-06-04 — add autoSyncInterval options 240/480/1440
// LAST_CHANGE: 2026-06-04 — move action buttons (Sync now + Open support) above full settings, just below wizard step 2
// LAST_CHANGE: 2026-06-07 — notifications: always show section on step 3; when hasActive → all notifications with buttons; else → 3 latest read (or empty state via notifications.empty)
// LAST_CHANGE: 2026-06-07 — throttle progress$ rendering with throttleTime(200ms, leading+trailing) to avoid per-article DOM thrashing during continuous sync
// END_CHANGE_SUMMARY
