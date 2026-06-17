// START_MODULE_CONTRACT
// PURPOSE: Plugin entry point — `export default class ReadinePlugin extends Plugin`. onload() wires the full module graph in dependency order: M-ERROR-HANDLER first, then settings → i18n → HTTP base + clients → AuthService → ErrorSender → vault file storage → sync chain (loadTasks → articles + files → delete-policy → orchestrator) → AutoSyncTimer → UI (AuthUI + SupportBundle + SupportUI + SettingTab) → commands + ribbon. onunload() runs in reverse: AutoSyncTimer.stop(), ErrorSender.unregister(), ErrorHandler.unregister(). handleSessionExpired() forces a re-render of the Settings tab so the re-auth banner appears immediately when a 401 lands mid-session. NSwag client adapter: Phase 5 sync modules consume a narrow ReadineApi {articleSync, fetchBinary}; we adapt apiFeedSync (NSwag) → articleSync (mapping the SyncArticlesResult into ArticleDelta). For fetchBinary we call obsidian.requestUrl directly with `arrayBuffer` mapping.
// SCOPE: src/main.ts
// DEPENDS: M-ERROR-HANDLER, M-ERROR-SENDER, M-AUTH-SERVICE, M-SETTINGS-MANAGER, M-SYNC-ORCHESTRATOR, M-AUTO-SYNC-TIMER, M-SETTINGS-UI, M-COMMANDS, M-RIBBON, M-I18N, M-HTTP-BASE, M-NOTIFICATIONS
// LINKS: UC-001, UC-002, UC-003, UC-004, UC-005, UC-006, UC-007, UC-008, UC-009, UC-012, UC-013, UC-014, UC-015, UC-016, UC-017, UC-018, UC-019, UC-020, UC-022, V-M-PLUGIN-MAIN
// ROLE: RUNTIME
// MAP_MODE: EXPORTS
// END_MODULE_CONTRACT

// START_MODULE_MAP
// default - default-exported Obsidian Plugin subclass ReadinePlugin (onload / onunload / handleSessionExpired)
// END_MODULE_MAP

import { Notice, Plugin } from "obsidian";

import {
  ApiClientBaseConfiguration,
} from "./api/base";
import { HttpClient } from "./api/angular-compat";
import { ApiClientLogsBaseConfiguration } from "./api/base-logs";
import { Client_V1_0 } from "./api/clientV1_0";
import { Client_V1_0_Logs } from "./api/clientV1_0.Logs";
import { AuthService } from "./auth/auth-service";
import { createDefaultI18n } from "./i18n/i18n-bridge";
import { detectDefaultLanguage, setLanguage } from "./i18n/i18n";
import { ErrorHandler } from "./logs/error-handler";
import { ErrorSender } from "./logs/error-sender";
import { LogRingBuffer } from "./logs/log-ring-buffer";
import { getConnection, onConnectionChange, type UnsubscribeFn } from "./network/network-detect";
import { isAllowed } from "./network/network-gate";
import {
  getPlatformLabel as getPlatLabel,
  getDeviceInfo,
  isMobile,
} from "./platform/platform";
import { getDefaults } from "./settings/settings-defaults";
import { SettingsManager } from "./settings/settings-manager";
import { VaultFileStorage } from "./storage/vault-file-storage";
import { SupportBundle } from "./support/support-bundle";
import { AutoSyncTimer } from "./sync/auto-sync-timer";
import { CacheCleanup } from "./sync/cache-cleanup";
import { DeletePolicyExecutor } from "./sync/delete-policy-executor";
import { SyncFiles } from "./sync/sync-files";

import { SyncOrchestrator } from "./sync/sync-orchestrator";
import { ArticleRegistry } from "./sync/article-registry";
import { AuthUI } from "./ui/auth-ui";
import { ReadineSettingTab } from "./ui/settings-ui";
import { SupportUI } from "./ui/support-ui";
import { VaultWriter } from "./vault/vault-writer";
import * as formatConverter from "./vault/format-converter";


import { UnpackService } from "./sync/unpack-service";
import { ArticleBodyLoader } from "./sync/article-body-loader";
import { NotificationsStore } from "./notifications/notifications-store";
import { NotificationsSync } from "./notifications/notifications-sync";

import { registerCommands } from "./plugin/commands";
import { registerRibbon } from "./plugin/ribbon";

// START_BLOCK_CONSTANTS
const MODULE_ID = "M-PLUGIN-MAIN";
// END_BLOCK_CONSTANTS

import {
  API_BASE_URL,
  LOGS_BASE_URL,
  API_VERSION,
  DS,
  getPlatformLabel,
  getClientVersion,
  getObsidianVersion,
  getDictCachePath,
  getRegistryPath,
  getNotificationsPath,
} from "./constants";

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

// START_CONTRACT: ReadinePlugin
// PURPOSE: Obsidian plugin entry point — wires all Readine modules in dependency order
// INPUTS: (Obsidian lifecycle) — onload() / onunload() invoked by the host
// OUTPUTS: side-effects (commands, ribbon, settings tab, timers, listeners)
// SIDE_EFFECTS: registers commands; adds ribbon icon; mounts settings tab; schedules auto-sync interval; installs error handler globally; subscribes to auth events
// LINKS: UC-001…UC-021, V-M-PLUGIN-MAIN
// END_CONTRACT: ReadinePlugin
export default class ReadinePlugin extends Plugin {
  // Phase 1
  private ringBuffer?: LogRingBuffer;
  // Phase 4
  private errorHandler?: ErrorHandler;
  private errorSender?: ErrorSender;
  // Phase 3
  private settings?: SettingsManager;
  // Phase 4 (auth) / Phase 3 (api)
  private apiClient?: Client_V1_0;
  private logsClient?: Client_V1_0_Logs;
  private authService?: AuthService;
  // Phase 2B (storage)
  private storage?: VaultFileStorage;
  // Phase 5 / 6 (sync)
  private syncFiles?: SyncFiles;
  private deleteExecutor?: DeletePolicyExecutor;
  private registry?: ArticleRegistry;
  private cacheCleanup?: CacheCleanup;
  private orchestrator?: SyncOrchestrator;
  private autoSyncTimer?: AutoSyncTimer;
  // Phase 7 (UI)
  private authUI?: AuthUI;
  private supportBundle?: SupportBundle;
  private supportUI?: SupportUI;
  private settingTab?: ReadineSettingTab;
  // Phase 10 (Notifications)
  private notificationsStore?: import("./notifications/notifications-store").NotificationsStore;
  private notificationsSync?: import("./notifications/notifications-sync").NotificationsSync;
  private unpackService?: UnpackService;
  /** Ribbon icon element returned by registerRibbon; carries badge teardown. */
  private _ribbonIconEl?: HTMLElement;
  /** Unsubscribe handle for onConnectionChange listener. */
  private _networkUnsub?: UnsubscribeFn;

  // START_CONTRACT: onload
  // PURPOSE: wire the full module graph in dependency order
  // INPUTS: none (Obsidian lifecycle)
  // OUTPUTS: Promise<void>
  // SIDE_EFFECTS: see class-level contract
  // LINKS: UC-001…UC-021, V-M-PLUGIN-MAIN
  // END_CONTRACT: onload
  async onload(): Promise<void> {
    // START_BLOCK_REGISTER_ERROR_HANDLER
    // STEP 1 — ERROR-HANDLER FIRST (per AGENTS.md). Captures any startup
    // failure from the wiring below.
    this.ringBuffer = new LogRingBuffer();
    this.errorHandler = new ErrorHandler({
      ringBuffer: this.ringBuffer,
      platform: { getPlatformLabel: getPlatLabel },
    });
    this.errorHandler.register();
    logInfo(
      "onload:BLOCK_REGISTER_ERROR_HANDLER",
      "ERROR_HANDLER_REGISTERED",
      "global error pipeline installed first per AGENTS.md invariant",
      "UC-018",
    );
    // END_BLOCK_REGISTER_ERROR_HANDLER

    // START_BLOCK_WIRE_ALL
    // STEP 2 — Settings init. Platform-aware defaults (mobile → Wi-Fi-only).
    const defaults = getDefaults(isMobile() ? "mobile" : "desktop");
    this.settings = new SettingsManager(this, defaults);
    await this.settings.init();

    // STEP 3 — i18n. If user has explicitly set a language via settings UI,
    // use that. Otherwise auto-detect from Obsidian's locale.
    const lang = this.settings.get("uiLanguageSet")
      ? this.settings.get("uiLanguage")
      : detectDefaultLanguage();
    await setLanguage(lang);

    // STEP 4 — HTTP base + NSwag clients. The base config holds the per-instance
    // getAuthId callback; AuthService is constructed shortly after but the
    // closure here resolves the token lazily so order doesn't matter.
    const apiConfig = new ApiClientBaseConfiguration(
      API_BASE_URL,
      API_VERSION,
      async () => this.settings?.get("sessionId") ?? null,
    );
    const httpClient = new HttpClient();
    this.apiClient = new Client_V1_0(apiConfig, httpClient, API_BASE_URL);
    const logsConfig = new ApiClientLogsBaseConfiguration(
      LOGS_BASE_URL,
      API_VERSION,
    );
    this.logsClient = new Client_V1_0_Logs(
      logsConfig,
      httpClient,
      LOGS_BASE_URL,
    );

    // STEP 5 — AuthService.
    const obsidianVersion = getObsidianVersion();
    this.authService = new AuthService({
      settings: this.settings,
      apiClient: this.apiClient,
      onSessionExpired: () => this.handleSessionExpired(),
      i18n: createDefaultI18n(),
      clientVersion: getClientVersion(this.manifest),
      platform: getPlatformLabel(obsidianVersion),
      ds: DS,
    });
    await this.authService.init();

    // STEP 5.5 — Clear ArticleRegistry on logout.
    // When a user disconnects (UC-002), the registry holds stale data from the
    // previous session: lastSyncStamp, pathMappings, entries, feeds.  Without
    // clearing, the next login would skip isFirstSync (lastSyncStamp > 0) and
    // pathMappings would force articles back to the old template paths.
    this.authService.subscribe((event) => {
      if (event.kind === "auth.disconnected") {
        this.registry?.fullReset().catch((err) => {
          logWarn(
            "onload:BLOCK_WIRE_ALL",
            "REGISTRY_RESET_FAILED",
            "registry fullReset on logout failed — swallowed",
            "UC-002",
            { err: err instanceof Error ? err.message : String(err) },
          );
        });
      }
    });

    // STEP 6 — ErrorSender. Subscribes to ErrorHandler.messages$; the auth
    // accessor here is intentionally a structural slice (getUserId only).
    this.errorSender = new ErrorSender({
      handler: this.errorHandler,
      logsClient: this.logsClient,
      auth: this.authService,
      platform: { getPlatformLabel: getPlatLabel, getDeviceInfo, isMobile },
      apiVersion: API_VERSION,
    });
    this.errorSender.register();

    // STEP 6.5 — Network cache. Subscribe to network changes so getConnection()
    // returns cached state invalidated by onConnectionChange.
    this._networkUnsub = onConnectionChange(() => {});

    // STEP 7 — VaultFileStorage. Single seam for all vault I/O.
    this.storage = new VaultFileStorage(this.app.vault);

    // STEP 7.5 — Unpack service + article body loader (zstd decompression via Web Worker).
    const unpackService = new UnpackService();
    this.unpackService = unpackService;
    const articleBodyLoader = new ArticleBodyLoader({
      storage: this.storage,
      unpackService,
      dictCachePath: getDictCachePath(this.manifest),
    });

    // STEP 7.6 — ArticleRegistry + CacheCleanup.
    this.registry = new ArticleRegistry({
      storage: this.storage,
      registryPath: getRegistryPath(this.manifest),
    });
    await this.registry.load();

    this.cacheCleanup = new CacheCleanup({
      storage: this.storage,
      settings: this.settings,
      registry: this.registry,
    });

    // STEP 8 — Sync chain.
    //
    // Obsidian attachment folder convention (4 UI variants mapped to getConfig("attachmentFolderPath")):
    //   "" or "."  → Same folder as current file   (resolveTargetDir returns articleDir)
    //   "./"       → Vault folder / root            (resolveTargetDir returns articleId)
    //   "./sub"    → In subfolder under current     (resolveTargetDir returns articleDir/sub/articleId)
    //   "path"     → In the folder specified below  (resolveTargetDir returns path/articleId)
    //
    // For per-article resolution using Obsidian's own logic, consider:
    //   await app.fileManager.getAvailablePathForAttachment("_.png", articlePath)
    // (requires async per-article resolution; the string heuristic above matches Obsidian's behavior)
    const vaultConfig = this.app.vault as unknown as { getConfig?: (key: string) => unknown };
    const linkPrefs = {
      useMarkdownLinks: vaultConfig.getConfig?.("useMarkdownLinks") ?? false,
      newLinkFormat: vaultConfig.getConfig?.("newLinkFormat") ?? "shortest",
      attachmentFolderPath: vaultConfig.getConfig?.("attachmentFolderPath") ?? "",
    } as import("./sync/base64-extractor").ObsidianLinkPrefs;

    const vaultWriter = new VaultWriter({ storage: this.storage, linkPrefs });

    this.syncFiles = new SyncFiles({
      vaultWriter,
      formatConverter: { convert: formatConverter.convert },
      settings: this.settings,
      registry: this.registry,
      networkGate: { isAllowed },
      networkDetect: { getConnection },
    });

    this.deleteExecutor = new DeletePolicyExecutor({
      storage: this.storage,
      settings: this.settings,
    });

    // STEP 8.5 — Notifications sync (Phase 10). File-backed store (stamp + records
    // in a separate JSON file, same pattern as ArticleRegistry) + API delta sync.
    // Created before orchestrator so it can be injected for parallel sync.
    const notificationsStore = new NotificationsStore({
      storage: this.storage,
      path: getNotificationsPath(this.manifest),
    });
    await notificationsStore.load();
    const notificationsSync = new NotificationsSync({
      store: notificationsStore,
      apiClient: this.apiClient,
      pluginVersion: getClientVersion(this.manifest),
    });
    this.notificationsStore = notificationsStore;
    this.notificationsSync = notificationsSync;

    this.orchestrator = new SyncOrchestrator({
      apiClient: this.apiClient,
      bodyLoader: articleBodyLoader,
      syncFiles: this.syncFiles,
      vaultWriter,
      deletePolicyExecutor: this.deleteExecutor,
      networkGate: { isAllowed },
      networkDetect: { getConnection },
      auth: this.authService,
      settings: this.settings,
      registry: this.registry,
      notificationsSync,
      cacheCleanup: this.cacheCleanup,
      storage: this.storage,
    });

    this.autoSyncTimer = new AutoSyncTimer({
      orchestrator: this.orchestrator,
      settings: this.settings,
      auth: this.authService,
    });

    // STEP 9 — UI surfaces. AuthUI + SupportBundle + SupportUI + SettingTab.
    const i18nLike = createDefaultI18n();
    this.authUI = new AuthUI({
      auth: this.authService,
      i18n: i18nLike,
      hasSessionExpiredFlag: () =>
        this.settings?.get("lastSyncError") === "session_expired",
      onLoginOutcome: (outcome) => {
        logInfo("onLoginOutcome", "DEBUG_LOGIN_OUTCOME", "onLoginOutcome callback fired", "UC-001",
            { ok: outcome.ok, hasUserId: "userId" in outcome, hasError: "error" in outcome });
        if (!outcome.ok) {
          new Notice(outcome.error ?? i18nLike.t("auth.error.network_error"));
        } else {
          this.settingTab?.display();
        }
      },
      onDisconnect: () => {
        new Notice(i18nLike.t("auth.disconnected"));
        this.settings?.set("wizardCompleted", false);
        this.settingTab?.display();
      },
    });

    this.supportBundle = new SupportBundle({
      platform: { isMobile, getPlatformLabel: getPlatLabel },
      auth: this.authService,
      ringBuffer: this.ringBuffer,
      settings: this.settings,
      pluginVersion: getClientVersion(this.manifest),
      obsidianVersion,
    });

    this.supportUI = new SupportUI(this.app, {
      bundle: this.supportBundle,
      i18n: i18nLike,
    });

    this.settingTab = new ReadineSettingTab(this.app, this, {
      settings: this.settings,
      i18n: i18nLike,
      orchestrator: this.orchestrator,
      authUI: this.authUI,
      supportUI: this.supportUI,
      notificationsStore,
    });
    this.addSettingTab(this.settingTab);

    // STEP 10 — Commands + Ribbon.
    registerCommands(this, {
      orchestrator: this.orchestrator,
      auth: this.authService,
      i18n: i18nLike,
    });
    this._ribbonIconEl = registerRibbon(this, {
      orchestrator: this.orchestrator,
      i18n: i18nLike,
      notificationsBadge: {
        unreadCount$: notificationsStore.unreadCount$,
        getUnreadCount: () => notificationsStore.getUnreadCount(),
        getNotificationsBadge: () => this.settings?.get("notificationsBadge") ?? true,
        onNotificationsBadgeChange: (cb) =>
          this.settings?.onChange("notificationsBadge", () => cb(this.settings?.get("notificationsBadge") ?? true)) ?? (() => {}),
      },
    });

    // STEP 11 — Auto-sync start. Reads autoSyncInterval; 'off' → no-op,
    // otherwise schedules setInterval; subscribes to settings.onChange to
    // restart on live updates.
    this.autoSyncTimer.start();

    logInfo(
      "onload:BLOCK_WIRE_ALL",
      "PLUGIN_READY",
      "all modules wired; ready for user interaction",
      "UC-001",
    );
    // END_BLOCK_WIRE_ALL
  }

  // START_CONTRACT: onunload
  // PURPOSE: tear down timers + global listeners installed during onload
  // INPUTS: none (Obsidian lifecycle)
  // OUTPUTS: void
  // SIDE_EFFECTS: stops AutoSyncTimer; unregisters ErrorSender + ErrorHandler; notifications cleanup
  // LINKS: UC-018, UC-022, V-M-PLUGIN-MAIN
  // END_CONTRACT: onunload
  onunload(): void {
    // START_BLOCK_TEARDOWN
    // Reverse-order teardown: timers first (so no tick fires after subscribers
    // are torn down), then error pipeline.
    try {
      this.autoSyncTimer?.stop();
    } catch (err) {
      logWarn(
        "onunload:BLOCK_TEARDOWN",
        "TEARDOWN_AUTO_SYNC_ERROR",
        "autoSyncTimer.stop threw — swallowed",
        "UC-004",
        { err: err instanceof Error ? err.message : String(err) },
      );
    }
    try {
      this.errorSender?.unregister();
    } catch (err) {
      logWarn(
        "onunload:BLOCK_TEARDOWN",
        "TEARDOWN_ERROR_SENDER_ERROR",
        "errorSender.unregister threw — swallowed",
        "UC-018",
        { err: err instanceof Error ? err.message : String(err) },
      );
    }
    try {
      this.errorHandler?.unregister();
    } catch (err) {
      logWarn(
        "onunload:BLOCK_TEARDOWN",
        "TEARDOWN_ERROR_HANDLER_ERROR",
        "errorHandler.unregister threw — swallowed",
        "UC-018",
        { err: err instanceof Error ? err.message : String(err) },
      );
    }
    // Teardown notifications: cancel any in-flight sync.
    try {
      this.notificationsSync?.cancel();
    } catch (err) {
      void err;
    }
    // Clean up ribbon badge subscription if stored on the icon element.
    try {
      const iconEl = (this as unknown as Record<string, unknown>)._ribbonIconEl as
        | (HTMLElement & { _badgeUnsubscribe?: () => void })
        | undefined;
      if (iconEl?._badgeUnsubscribe) {
        iconEl._badgeUnsubscribe();
      }
    } catch (err) {
      void err;
    }
    // Teardown network listener.
    try {
      this._networkUnsub?.();
      this._networkUnsub = undefined;
    } catch (err) {
      void err;
    }
    logInfo(
      "onunload:BLOCK_TEARDOWN",
      "PLUGIN_UNLOADED",
      "auto-sync stopped; error pipeline detached",
      "UC-001",
    );
    // END_BLOCK_TEARDOWN
  }

  // START_CONTRACT: handleSessionExpired
  // PURPOSE: re-render the Settings tab so the re-auth banner appears on a 401 mid-session
  // INPUTS: none — invoked from AuthService.deps.onSessionExpired
  // OUTPUTS: void
  // SIDE_EFFECTS: re-invokes settingTab.display(); never touches vault (UC-015)
  // LINKS: UC-015, V-M-PLUGIN-MAIN
  // END_CONTRACT: handleSessionExpired
  handleSessionExpired(): void {
    // The Settings tab subscribes to AuthEvents via M-AUTH-UI; its handler
    // already re-renders on session-expired. We still surface a re-render
    // here defensively — if the tab is currently mounted, the banner
    // becomes visible immediately. If it's not mounted, the next display()
    // (when the user opens it) will pick up the lastSyncError flag via
    // `hasSessionExpiredFlag` and render the banner.
    try {
      this.settingTab?.display();
    } catch (err) {
      logWarn(
        "handleSessionExpired",
        "RE_RENDER_FAILED",
        "settingTab.display threw during session-expired handler",
        "UC-015",
        { err: err instanceof Error ? err.message : String(err) },
      );
    }
  }
}

// START_CHANGE_SUMMARY
// LAST_CHANGE: 2026-05-31 — pass Obsidian linkPrefs to VaultWriter; read vault config for useMarkdownLinks + newLinkFormat
// LAST_CHANGE: 2026-06-02 — wire onLoginOutcome + onDisconnect callbacks for user-visible Notice feedback
// LAST_CHANGE: 2026-06-03 — trigger settingTab.display() after successful login and after disconnect to advance wizard step
// LAST_CHANGE: 2026-06-03 — reset wizardCompleted on disconnect; wire wizard state + auto-sync gate for Option A
// LAST_CHANGE: 2026-06-04 — fix getObsidianVersion call: remove this.app param
// LAST_CHANGE: 2026-06-07 — restore cached notifications from file-backed NotificationsStore on startup
// LAST_CHANGE: 2026-06-07 — switch to file-backed NotificationsStore (IFileStorage + getNotificationsPath); remove settings dep from NotificationsSync
// LAST_CHANGE: 2026-06-07 — document Obsidian 4 attachment folder UI variants in linkPrefs construction
// LAST_CHANGE: 2026-06-07 — subscribe to auth.disconnected event → clear ArticleRegistry (full reset) to prevent stale lastSyncStamp/pathMappings from previous session leaking into next login (UC-002).
// END_CHANGE_SUMMARY
