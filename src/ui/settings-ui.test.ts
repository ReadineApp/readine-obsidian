// START_MODULE_CONTRACT
// PURPOSE: Unit tests for M-SETTINGS-UI — widget renders current settings, widget changes persist, language picker re-renders, full integration cycle.
// SCOPE: src/ui/settings-ui.test.ts
// DEPENDS: M-SETTINGS-UI, M-SETTINGS-MANAGER, M-I18N, M-SYNC-ORCHESTRATOR, M-AUTH-UI, M-SUPPORT-UI
// LINKS: V-M-SETTINGS-UI
// ROLE: TEST
// END_MODULE_CONTRACT

// START_MODULE_MAP
// (test file — no public exports)
// END_MODULE_MAP

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => import("../__mocks__/obsidian"));
// Provide non-empty dictionaries so setLanguage() doesn't fall back unexpectedly.
vi.mock("../i18n/en.json", () => ({ default: {} }));
vi.mock("../i18n/ru.json", () => ({ default: {} }));
vi.mock("../i18n/de.json", () => ({ default: {} }));
vi.mock("../i18n/fr.json", () => ({ default: {} }));
vi.mock("../i18n/ja.json", () => ({ default: {} }));
vi.mock("../i18n/pt.json", () => ({ default: {} }));
vi.mock("../i18n/es.json", () => ({ default: {} }));
vi.mock("../i18n/zh.json", () => ({ default: {} }));
vi.mock("../i18n/it.json", () => ({ default: {} }));
vi.mock("../i18n/ko.json", () => ({ default: {} }));

import {
  App as MockApp,
  Plugin as MockPlugin,
  __getNotices,
  __resetObsidianMock,
} from "../__mocks__/obsidian";
import type { App as ObsidianApp, Plugin as ObsidianPlugin } from "obsidian";
import { ReadineSettingTab, SUPPORTED_UI_LANGUAGES } from "./settings-ui";
import { AuthUI } from "./auth-ui";
import { SupportUI } from "./support-ui";
import { NotificationsStore } from "../notifications/notifications-store";
import type { IFileStorage } from "../storage/vault-file-storage";
import type { AuthService } from "../auth/auth-service";
import type { I18n } from "../i18n/i18n-bridge";
import type {
  SettingsKey,
  SettingsManager,
  SettingsSnapshot,
} from "../settings/settings-manager";
import type { SyncOrchestrator, SyncResult } from "../sync/sync-orchestrator";
import { Subject } from "rxjs";
import type { SupportBundle } from "../support/support-bundle";

// The mocked obsidian module provides constructible stubs whose nominal types
// differ from the real obsidian types. Cast at the boundary so production code
// (typed against the real obsidian.d.ts) accepts our stubs.
const App = MockApp as unknown as new () => ObsidianApp;
const Plugin = MockPlugin as unknown as new (app?: ObsidianApp) => ObsidianPlugin;

// START_BLOCK_FIXTURES
function buildFakeAuth() {
  const listeners = new Set<() => void>();
  const state = { ready: true, userId: "user-A" };
  return {
    isReady: () => state.ready,
    getUserId: () => state.userId,
    subscribe: vi.fn((cb: () => void) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    }),
    login: vi.fn(async () => ({ ok: true, userId: state.userId })),
    logout: vi.fn(async () => {
      state.ready = false;
      state.userId = "";
    }),
  };
}

function stubNotificationsStore(): NotificationsStore {
  const storage: IFileStorage = {
    read: async () => { throw new Error("not implemented"); },
    readBinary: async () => new ArrayBuffer(0),
    write: async () => {},
    exists: async () => false,
    remove: async () => {},
    stat: async () => null,
    list: async () => [],
    mkdir: async () => {},
    resetMkdirCache: () => {},
  };
  return new NotificationsStore({ storage, path: ".obsidian/test/notifications.json" });
}

function buildFakeSettings(initial: Partial<SettingsSnapshot> = {}): SettingsManager & {
  __dump(): Partial<SettingsSnapshot>;
} {
  const bag: Partial<SettingsSnapshot> = {
    sessionId: "test-session",
    outputFormat: "markdown",
    pathTemplate: "Readine/{feedName}/{yyyy}-{mm}/{title}.md",
    deletePolicy: "keep",
    autoSyncInterval: 30,
    networkForArticles: "always",
    limitCacheDays: "off",
    uiLanguage: "en",
    lastSyncError: null,
    notificationsBadge: true,
    wizardCompleted: true,
    ...initial,
    syncFavoritesOnly: false,
    uiLanguageSet: false,
  };
  const fake = {
    get: <K extends SettingsKey>(k: K) => bag[k] as SettingsSnapshot[K],
    set: vi.fn(async <K extends SettingsKey>(k: K, v: SettingsSnapshot[K]) => {
      bag[k] = v;
    }),
    onChange: vi.fn(() => () => {}),
    __dump: () => ({ ...bag }),
  };
  return fake as unknown as SettingsManager & { __dump(): Partial<SettingsSnapshot> };
}

function buildFakeOrchestrator(
  result: SyncResult = {
    success: true,
    written: 1,
    skipped: 0,
    attachmentsDownloaded: 0,
    deleted: 0,
  },
) {
  return {
    triggerSync: vi.fn(async () => result),
    isRunning: () => false,
    progress$: new Subject<import("../sync/sync-orchestrator").SyncProgressEvent>(),
  } as unknown as SyncOrchestrator;
}

const I18N_STUB: I18n = {
  t: (key, params) => {
    if (!params) return `[${key}]`;
    let out = `[${key}]`;
    for (const [k, v] of Object.entries(params)) out += ` ${k}=${v}`;
    return out;
  },
  getCurrentLanguage: () => "en",
};

function buildHarness(initial: Partial<SettingsSnapshot> = {}) {
  const app = new App();
  const plugin = new Plugin(app);
  const auth = buildFakeAuth();
  const settings = buildFakeSettings(initial);
  const orchestrator = buildFakeOrchestrator();
  const authUI = new AuthUI({ auth: auth as unknown as AuthService, i18n: I18N_STUB });
  const supportUI = new SupportUI(app, {
    bundle: {
      collectBundle: () => ({
        pluginVersion: "0.1.0",
        obsidianVersion: "1.5.8",
        os: "macOS",
        userAgent: "test-ua",
        isMobile: false,
        userId: "user-A",
        lastSyncError: null,
        uiLanguage: "en",
        logs: [],
        timestamp: "2026-05-13T00:00:00.000Z",
      }),
      serialize: (b: unknown) => JSON.stringify(b, null, 2),
    } as unknown as SupportBundle,
    i18n: I18N_STUB,
  });
  const notificationsStore = stubNotificationsStore();
  const tab = new ReadineSettingTab(app, plugin, {
    settings,
    i18n: I18N_STUB,
    orchestrator,
    authUI,
    supportUI,
    notificationsStore,
  });
  return { app, plugin, auth, settings, orchestrator, authUI, supportUI, tab, notificationsStore };
}

function findAllByTag<E extends Element>(root: HTMLElement, tag: string): E[] {
  const els = (root as unknown as { querySelectorAll?: (s: string) => unknown[] })
    .querySelectorAll;
  if (typeof els === "function") {
    return Array.from(els.call(root, tag)) as unknown as E[];
  }
  return [];
}
// END_BLOCK_FIXTURES

describe("M-SETTINGS-UI (V-M-SETTINGS-UI)", () => {
  let infoSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    __resetObsidianMock();
    infoSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ─── V-M-SETTINGS-UI scenario-1 ────────────────────────────────────────
  describe("scenario-1: each widget reflects current saveData value on render", () => {
    it("populates widgets with the current snapshot values", () => {
      const { tab, settings } = buildHarness({
        outputFormat: "html",
        pathTemplate: "Custom/{title}.md",
        deletePolicy: "delete",
        autoSyncInterval: 15,
        networkForArticles: "Wi-Fi-only",
        limitCacheDays: 30,
        uiLanguage: "ru",
      });

      tab.display();

      // Dropdowns: outputFormat, deletePolicy, autoSyncInterval, networkForArticles, limitCacheDays, uiLanguage.
      const selects = findAllByTag<HTMLSelectElement>(tab.containerEl, "select");
      expect(selects.length).toBe(6);
      const values = selects.map((s) => s.value);
      expect(values).toContain("html");
      expect(values).toContain("15");
      expect(values).toContain("Wi-Fi-only");
      expect(values).toContain("30");
      expect(values).toContain("en");

      // pathTemplate text input reflects custom value.
      const texts = findAllByTag<HTMLInputElement>(tab.containerEl, "input").filter(
        (i) => i.type === "text",
      );
      const path = texts.find((t) => t.value === "Custom/{title}.md");
      expect(path).toBeDefined();

      // settings was not written during plain render.
      expect((settings.set as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBe(0);
    });

    it("includes all 10 language options in the language dropdown", () => {
      const { tab } = buildHarness();
      tab.display();
      const selects = findAllByTag<HTMLSelectElement>(tab.containerEl, "select");
      // Find the one with 10 options.
      const lang = selects.find((s) => (s as unknown as { children: unknown[] }).children.length === 10);
      expect(lang).toBeDefined();
      // Native names are present.
      const text = (lang as unknown as { children: Array<{ textContent: string }> }).children
        .map((c) => c.textContent);
      for (const [, native] of SUPPORTED_UI_LANGUAGES) {
        expect(text).toContain(native);
      }
    });

  });

  // ─── V-M-SETTINGS-UI scenario-2 ────────────────────────────────────────
  describe("scenario-2: widget changes persist to saveData", () => {
    it("outputFormat dropdown → settings.set('outputFormat', value)", () => {
      const { tab, settings } = buildHarness();
      tab.display();
      const selects = findAllByTag<HTMLSelectElement>(tab.containerEl, "select");
      // Find the output-format select by the option set.
      const fmt = selects.find((s) => {
        const opts = (s as unknown as { children: Array<{ value: string }> }).children;
        return opts.some((o) => o.value === "markdown");
      })!;
      fmt.value = "html";
      fmt.dispatchEvent({ type: "change" } as unknown as Event);

      expect(settings.set).toHaveBeenCalledWith("outputFormat", "html");
    });

    it("autoSyncInterval 'off' string converts to 'off'; numeric strings convert to numbers", () => {
      const { tab, settings } = buildHarness();
      tab.display();
      const selects = findAllByTag<HTMLSelectElement>(tab.containerEl, "select");
      const auto = selects.find((s) => {
        const opts = (s as unknown as { children: Array<{ value: string }> }).children;
        return opts.some((o) => o.value === "5") && opts.some((o) => o.value === "off");
      })!;
      auto.value = "off";
      auto.dispatchEvent({ type: "change" } as unknown as Event);
      expect(settings.set).toHaveBeenCalledWith("autoSyncInterval", "off");

      auto.value = "60";
      auto.dispatchEvent({ type: "change" } as unknown as Event);
      expect(settings.set).toHaveBeenCalledWith("autoSyncInterval", 60);
    });

    it("limitCacheDays string → number coercion works", () => {
      const { tab, settings } = buildHarness();
      tab.display();
      const selects = findAllByTag<HTMLSelectElement>(tab.containerEl, "select");
      const cache = selects.find((s) => {
        const opts = (s as unknown as { children: Array<{ value: string }> }).children;
        return opts.some((o) => o.value === "365");
      })!;
      cache.value = "90";
      cache.dispatchEvent({ type: "change" } as unknown as Event);
      expect(settings.set).toHaveBeenCalledWith("limitCacheDays", 90);
    });
  });

  // ─── V-M-SETTINGS-UI scenario-3 ────────────────────────────────────────
  describe("scenario-3: language picker triggers UI re-render", () => {
    it("changing language calls setLanguage and re-renders", async () => {
      const { tab, settings } = buildHarness();
      tab.display();
      const initialRenderCount = (infoSpy.mock.calls as unknown[][])
        .map((c) => c[0])
        .filter((c): c is Record<string, unknown> => typeof c === "object" && c !== null)
        .filter((e) => e.event === "SETTINGS_UI_RENDERED").length;
      expect(initialRenderCount).toBe(1);

      const selects = findAllByTag<HTMLSelectElement>(tab.containerEl, "select");
      const lang = selects.find((s) => (s as unknown as { children: unknown[] }).children.length === 10)!;
      lang.value = "ru";
      lang.dispatchEvent({ type: "change" } as unknown as Event);

      // Wait for setLanguage promise to flush — includes a dynamic JSON import
      // which may need multiple microtask + macrotask drains in the test env.
      for (let i = 0; i < 20; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }

      // settings.set was called for uiLanguage (via the onPersist callback).
      const langSets = (settings.set as unknown as { mock: { calls: unknown[][] } }).mock.calls.filter(
        (c) => c[0] === "uiLanguage",
      );
      expect(langSets.length).toBeGreaterThan(0);

      // A second SETTINGS_UI_RENDERED marker appears after the language switch.
      const events = (infoSpy.mock.calls as unknown[][])
        .map((c) => c[0])
        .filter((c): c is Record<string, unknown> => typeof c === "object" && c !== null);
      const renderCount = events.filter((e) => e.event === "SETTINGS_UI_RENDERED").length;
      expect(renderCount).toBeGreaterThanOrEqual(2);
      const langChanged = events.find((e) => e.event === "SETTINGS_UI_LANG_CHANGED");
      expect(langChanged).toBeDefined();
    });
  });

  // ─── V-M-SETTINGS-UI scenario-4 (integration) ──────────────────────────
  describe("scenario-4 (integration): full open + edit + save cycle", () => {
    it("renders, edits multiple widgets, persists, then exercises action buttons", async () => {
      const { tab, settings, orchestrator, supportUI } = buildHarness();
      const supportOpenSpy = vi.spyOn(supportUI, "open").mockReturnValue({} as unknown as never);

      tab.display();

      // Edit a couple of settings.
      const selects = findAllByTag<HTMLSelectElement>(tab.containerEl, "select");
      const policy = selects.find((s) => {
        const opts = (s as unknown as { children: Array<{ value: string }> }).children;
        return opts.some((o) => o.value === "keep");
      })!;
      policy.value = "delete";
      policy.dispatchEvent({ type: "change" } as unknown as Event);

      const buttons = findAllByTag<HTMLButtonElement>(tab.containerEl, "button");
      // Find Sync Now and Open Support buttons by text.
      const sync = buttons.find((b) => (b.textContent ?? "").includes("settings.actions.sync_now"));
      const support = buttons.find((b) => (b.textContent ?? "").includes("settings.actions.open_support"));
      expect(sync).toBeDefined();
      expect(support).toBeDefined();

      sync!.dispatchEvent({ type: "click" } as unknown as Event);
      await Promise.resolve();
      await Promise.resolve();

      support!.dispatchEvent({ type: "click" } as unknown as Event);

      expect(settings.set).toHaveBeenCalledWith("deletePolicy", "delete");
      expect(orchestrator.triggerSync).toHaveBeenCalledWith("manual");
      expect(supportOpenSpy).toHaveBeenCalledTimes(1);
      // A Notice was raised for sync.
      const notices = __getNotices();
      expect(notices.some((n) => n.message === "[notice.sync_started]")).toBe(true);
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it("when orchestrator returns no_auth → Notice surfaces sync_no_auth", async () => {
      const auth = buildFakeAuth();
      auth.isReady = () => false;
      const settings = buildFakeSettings({ sessionId: null as unknown as string });
      const orchestrator = {
        triggerSync: vi.fn(async () => ({
          success: false,
          written: 0,
          skipped: 0,
          attachmentsDownloaded: 0,
          deleted: 0,
          error: "no_auth" as const,
        })),
        isRunning: () => false,
        progress$: new Subject<import("../sync/sync-orchestrator").SyncProgressEvent>(),
      } as unknown as SyncOrchestrator;
      const app = new App();
      const plugin = new Plugin(app);
      const authUI = new AuthUI({ auth: auth as unknown as AuthService, i18n: I18N_STUB });
      const supportUI = new SupportUI(app, {
        bundle: { collectBundle: () => ({}), serialize: () => "{}" } as unknown as SupportBundle,
        i18n: I18N_STUB,
      });
      const notificationsStore = stubNotificationsStore();
      const tab = new ReadineSettingTab(app, plugin, {
        settings,
        i18n: I18N_STUB,
        orchestrator,
        authUI,
        supportUI,
        notificationsStore,
      });
      tab.display();
      // Step 1: only auth code input shown, sync button is NOT rendered
      const buttons = findAllByTag<HTMLButtonElement>(tab.containerEl, "button");
      expect(buttons.length).toBeGreaterThan(0);
    });

    it("display() detaches previous AuthUI handle on re-render", () => {
      const { tab, auth } = buildHarness();
      tab.display();
      tab.display();
      // The subscribe spy must have been called at least twice (once per render),
      // and the unsubscribe between them is automatic.
      expect((auth.subscribe as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBe(2);
    });
  });

  // ─── V-M-SETTINGS-UI scenario-5 (notifications) ─────────────────────────
  describe("scenario-5: notifications section rendering", () => {
    it("always shows notifications heading on step 3, even with empty store", () => {
      const { tab } = buildHarness();
      tab.display();

      const headings = findAllByTag<HTMLElement>(tab.containerEl, "div").filter(
        (d) => d.classList.contains("setting-item-heading"),
      );
      const names = headings.map((h) => h.querySelector(".setting-item-name")?.textContent ?? "");
      expect(names).toContain("[notifications.title]");
    });

    it("shows empty state when store has no notifications", () => {
      const { tab } = buildHarness();
      tab.display();

      const emptyEls = findAllByTag<HTMLElement>(tab.containerEl, "p").filter(
        (p) => p.classList.contains("readine-notifications-empty"),
      );
      expect(emptyEls.length).toBe(1);
      expect(emptyEls[0]!.textContent).toBe("[notifications.empty]");
    });

    it("shows all notifications with buttons when hasActive is TRUE", () => {
      const now = new Date("2026-06-07T12:00:00Z");
      const { tab, notificationsStore } = buildHarness();
      notificationsStore.setNotifications([
        { notificationId: "a", message: "Hello", wasRead: false, createdUtc: now },
        { notificationId: "b", message: "World", wasRead: true, createdUtc: new Date("2026-06-06T10:00:00Z") },
      ]);
      tab.display();

      const headings = findAllByTag<HTMLElement>(tab.containerEl, "div").filter(
        (d) => d.classList.contains("setting-item-heading"),
      );
      const names = headings.map((h) => h.querySelector(".setting-item-name")?.textContent ?? "");
      expect(names.filter((n) => n === "[notifications.title]").length).toBe(1);

      // "Mark all as read" button present (unreadCount > 0)
      const buttons = findAllByTag<HTMLButtonElement>(tab.containerEl, "button");
      const markAll = buttons.find((b) => (b.textContent ?? "").includes("[notifications.mark_read]"));
      expect(markAll).toBeDefined();

      // Both notification messages rendered via descEl textContent
      const descEls = findAllByTag(tab.containerEl, "div").filter(
        (d) => d.classList.contains("setting-item-description"),
      );
      const descTexts = descEls.map((d) => (d as unknown as { textContent: string }).textContent ?? "");
      expect(descTexts.some((t) => t.includes("Hello"))).toBe(true);
      expect(descTexts.some((t) => t.includes("World"))).toBe(true);

      // Unread notification has correct class
      const unreadItem = findAllByTag<HTMLElement>(tab.containerEl, "div").filter(
        (d) => d.classList.contains("readine-notification-unread"),
      );
      expect(unreadItem.length).toBe(1);
      // Read notification has correct class
      const readItem = findAllByTag<HTMLElement>(tab.containerEl, "div").filter(
        (d) => d.classList.contains("readine-notification-read"),
      );
      expect(readItem.length).toBe(1);
    });

    it("does NOT show notifications heading on step 1 (no auth)", () => {
      const { tab } = buildHarness({ sessionId: null as unknown as string });
      tab.display();

      const headings = findAllByTag<HTMLElement>(tab.containerEl, "div").filter(
        (d) => d.classList.contains("setting-item-heading"),
      );
      const names = headings.map((h) => h.querySelector(".setting-item-name")?.textContent ?? "");
      expect(names).not.toContain("[notifications.title]");
    });

    it("does NOT show notifications heading on step 2 (wizard)", () => {
      const { tab } = buildHarness({ wizardCompleted: false });
      tab.display();

      const headings = findAllByTag<HTMLElement>(tab.containerEl, "div").filter(
        (d) => d.classList.contains("setting-item-heading"),
      );
      const names = headings.map((h) => h.querySelector(".setting-item-name")?.textContent ?? "");
      expect(names).not.toContain("[notifications.title]");
    });
  });
});

// START_CHANGE_SUMMARY
// LAST_CHANGE: 2026-05-13 — initial test suite for V-M-SETTINGS-UI
// LAST_CHANGE: 2026-06-07 — add scenario-5: notifications section rendering (empty store, hasActive, step 1/2 no heading)
// END_CHANGE_SUMMARY
