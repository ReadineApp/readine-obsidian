// START_MODULE_CONTRACT
// PURPOSE: Unit tests for M-SETTINGS-MANAGER — typed get/set/getAll/onChange semantics, plugin.saveData/loadData round-trip, and required log markers (SETTING_PERSISTED, SETTINGS_INITIALIZED).
// SCOPE: src/settings/settings-manager.test.ts
// DEPENDS: M-SETTINGS-MANAGER, M-SETTINGS-DEFAULTS
// LINKS: V-M-SETTINGS-MANAGER
// ROLE: TEST
// END_MODULE_CONTRACT

// START_MODULE_MAP
// (test file — no public exports)
// END_MODULE_MAP

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => import("../__mocks__/obsidian"));

import {
  PluginStorageLike,
  SettingsManager,
  SettingsSnapshot,
} from "./settings-manager";
import { getDefaults } from "./settings-defaults";

// START_BLOCK_PLUGIN_MOCK
/**
 * Minimal in-memory PluginStorageLike. Captures every saveData payload so we
 * can assert persistence and inspect the merged-over-defaults behavior on
 * subsequent loadData calls.
 */
class MockPluginStorage implements PluginStorageLike {
  private _data: object | null;
  public readonly saveCalls: object[] = [];
  public readonly loadCalls: number[] = [];

  constructor(initial: object | null = null) {
    this._data = initial;
  }

  async saveData(data: object): Promise<void> {
    this.saveCalls.push({ ...data });
    this._data = { ...data };
  }

  async loadData(): Promise<object | null> {
    this.loadCalls.push(this.loadCalls.length + 1);
    return this._data === null ? null : { ...this._data };
  }
}
// END_BLOCK_PLUGIN_MOCK

function desktopDefaults(): SettingsSnapshot {
  return getDefaults("desktop");
}

describe("M-SETTINGS-MANAGER (V-M-SETTINGS-MANAGER)", () => {
  let infoSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    infoSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // V-M-SETTINGS-MANAGER scenario-1: get/set/getAll round-trip via saveData mock
  describe("scenario-1: get/set/getAll round-trip via saveData", () => {
    it("persists a set value to plugin.saveData and returns it from get()", async () => {
      const plugin = new MockPluginStorage();
      const mgr = new SettingsManager(plugin, desktopDefaults());
      await mgr.init();

      expect(mgr.get("outputFormat")).toBe("markdown");
      await mgr.set("outputFormat", "html");
      expect(mgr.get("outputFormat")).toBe("html");

      expect(plugin.saveCalls).toHaveLength(1);
      expect((plugin.saveCalls[0] as SettingsSnapshot).outputFormat).toBe("html");
    });

    it("getAll() returns a snapshot reflecting all current keys", async () => {
      const plugin = new MockPluginStorage();
      const mgr = new SettingsManager(plugin, desktopDefaults());
      await mgr.init();
      await mgr.set("uiLanguage", "ru");
      await mgr.set("autoSyncInterval", 60);

      const snap = mgr.getAll();
      expect(snap.uiLanguage).toBe("ru");
      expect(snap.autoSyncInterval).toBe(60);
      // Unchanged keys remain at their default values.
      expect(snap.deletePolicy).toBe("keep");
    });

    it("does not call saveData when set() receives the same value", async () => {
      const plugin = new MockPluginStorage();
      const mgr = new SettingsManager(plugin, desktopDefaults());
      await mgr.init();
      await mgr.set("uiLanguage", "en"); // same as default
      expect(plugin.saveCalls).toHaveLength(0);
    });

    it("emits SETTING_PERSISTED log marker with anchor set:BLOCK_PERSIST", async () => {
      const plugin = new MockPluginStorage();
      const mgr = new SettingsManager(plugin, desktopDefaults());
      await mgr.init();
      infoSpy.mockClear();
      await mgr.set("autoSyncInterval", 15);

      const payloads = (infoSpy.mock.calls as unknown[][])
        .map((c) => c[0])
        .filter((c): c is Record<string, unknown> => typeof c === "object" && c !== null);
      const event = payloads.find(
        (p) => p.event === "SETTING_PERSISTED" && p.module === "M-SETTINGS-MANAGER",
      );
      expect(event).toBeDefined();
      expect(event!.anchor).toBe("set:BLOCK_PERSIST");
      expect((event as Record<string, unknown>).key).toBe("autoSyncInterval");
    });
  });

  // V-M-SETTINGS-MANAGER scenario-2: onChange callback fires on set
  describe("scenario-2: onChange callback fires on set", () => {
    it("invokes the listener with (newValue, oldValue) on set()", async () => {
      const plugin = new MockPluginStorage();
      const mgr = new SettingsManager(plugin, desktopDefaults());
      await mgr.init();
      const cb = vi.fn();
      mgr.onChange("uiLanguage", cb);
      await mgr.set("uiLanguage", "ru");
      expect(cb).toHaveBeenCalledTimes(1);
      expect(cb).toHaveBeenCalledWith("ru", "en");
    });

    it("supports multiple listeners on the same key", async () => {
      const plugin = new MockPluginStorage();
      const mgr = new SettingsManager(plugin, desktopDefaults());
      await mgr.init();
      const a = vi.fn();
      const b = vi.fn();
      mgr.onChange("autoSyncInterval", a);
      mgr.onChange("autoSyncInterval", b);
      await mgr.set("autoSyncInterval", 60);
      expect(a).toHaveBeenCalledWith(60, 5);
      expect(b).toHaveBeenCalledWith(60, 5);
    });

    it("returns an unsubscribe handle that detaches the listener", async () => {
      const plugin = new MockPluginStorage();
      const mgr = new SettingsManager(plugin, desktopDefaults());
      await mgr.init();
      const cb = vi.fn();
      const off = mgr.onChange("deletePolicy", cb);
      await mgr.set("deletePolicy", "delete");
      expect(cb).toHaveBeenCalledTimes(1);
      off();
      await mgr.set("deletePolicy", "delete");
      expect(cb).toHaveBeenCalledTimes(1);
    });

    it("does not fire listeners when set() is a no-op (same value)", async () => {
      const plugin = new MockPluginStorage();
      const mgr = new SettingsManager(plugin, desktopDefaults());
      await mgr.init();
      const cb = vi.fn();
      mgr.onChange("uiLanguage", cb);
      await mgr.set("uiLanguage", "en"); // already 'en' from defaults
      expect(cb).not.toHaveBeenCalled();
    });

    it("isolates listener exceptions — the persist completes and remaining listeners fire", async () => {
      const plugin = new MockPluginStorage();
      const mgr = new SettingsManager(plugin, desktopDefaults());
      await mgr.init();
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const throwing = vi.fn(() => {
        throw new Error("boom");
      });
      const good = vi.fn();
      mgr.onChange("uiLanguage", throwing);
      mgr.onChange("uiLanguage", good);
      await expect(mgr.set("uiLanguage", "ru")).resolves.toBeUndefined();
      expect(throwing).toHaveBeenCalled();
      expect(good).toHaveBeenCalledWith("ru", "en");
      expect(plugin.saveCalls).toHaveLength(1);
      expect(errSpy).toHaveBeenCalled();
    });
  });

  // V-M-SETTINGS-MANAGER scenario-3: first-run: getAll returns defaults from SETTINGS-DEFAULTS
  describe("scenario-3: first-run defaults", () => {
    it("init() with no persisted data populates the snapshot from defaults", async () => {
      const plugin = new MockPluginStorage(null);
      const mgr = new SettingsManager(plugin, desktopDefaults());
      await mgr.init();
      const snap = mgr.getAll();
      expect(snap).toEqual(desktopDefaults());
      expect(plugin.loadCalls).toHaveLength(1);
      // First-run init must NOT pre-emptively saveData — that happens on the first
      // user-driven mutation.
      expect(plugin.saveCalls).toHaveLength(0);
    });

    it("emits SETTINGS_INITIALIZED log marker with anchor 'loadDefaults' and firstRun=true", async () => {
      const plugin = new MockPluginStorage(null);
      const mgr = new SettingsManager(plugin, desktopDefaults());
      await mgr.init();
      const payloads = (infoSpy.mock.calls as unknown[][])
        .map((c) => c[0])
        .filter((c): c is Record<string, unknown> => typeof c === "object" && c !== null);
      const event = payloads.find(
        (p) => p.event === "SETTINGS_INITIALIZED" && p.module === "M-SETTINGS-MANAGER",
      );
      expect(event).toBeDefined();
      expect(event!.anchor).toBe("loadDefaults");
      expect((event as Record<string, unknown>).firstRun).toBe(true);
    });

    it("marks initialized via __isInitializedForTests", async () => {
      const plugin = new MockPluginStorage(null);
      const mgr = new SettingsManager(plugin, desktopDefaults());
      expect(mgr.__isInitializedForTests()).toBe(false);
      await mgr.init();
      expect(mgr.__isInitializedForTests()).toBe(true);
    });
  });

  // V-M-SETTINGS-MANAGER scenario-4: full saveData → loadData cycle через Obsidian mock
  describe("scenario-4: saveData → loadData cycle", () => {
    it("a second SettingsManager hydrates from the first's persisted state", async () => {
      const plugin = new MockPluginStorage();
      const mgrA = new SettingsManager(plugin, desktopDefaults());
      await mgrA.init();
      await mgrA.set("sessionId", "tok-123");
      await mgrA.set("userId", "u-42");
      await mgrA.set("uiLanguage", "ru");

      // Fresh manager, same plugin: persisted snapshot wins over defaults.
      const mgrB = new SettingsManager(plugin, desktopDefaults());
      await mgrB.init();
      expect(mgrB.get("sessionId")).toBe("tok-123");
      expect(mgrB.get("userId")).toBe("u-42");
      expect(mgrB.get("uiLanguage")).toBe("ru");
      // Unset keys still take their default value.
      expect(mgrB.get("deletePolicy")).toBe("keep");
    });

    it("loadData with partial data merges over defaults (no destruction)", async () => {
      // Simulate a settings file written by an earlier plugin version that only
      // persisted `uiLanguage` and `sessionId`.
      const plugin = new MockPluginStorage({
        uiLanguage: "fr",
        sessionId: "legacy-token",
      });
      const mgr = new SettingsManager(plugin, desktopDefaults());
      await mgr.init();
      expect(mgr.get("uiLanguage")).toBe("fr");
      expect(mgr.get("sessionId")).toBe("legacy-token");
      // Missing keys fall back to defaults rather than `undefined`.
      expect(mgr.get("outputFormat")).toBe("markdown");
      expect(mgr.get("autoSyncInterval")).toBe(5);
    });

    it("ignores `undefined` values inside persisted data and keeps the default", async () => {
      const plugin = new MockPluginStorage({
        uiLanguage: undefined,
        outputFormat: "plain",
      });
      const mgr = new SettingsManager(plugin, desktopDefaults());
      await mgr.init();
      expect(mgr.get("uiLanguage")).toBe("en");
      expect(mgr.get("outputFormat")).toBe("plain");
    });

    it("saveData payload contains the full snapshot (round-trip-safe)", async () => {
      const plugin = new MockPluginStorage();
      const mgr = new SettingsManager(plugin, desktopDefaults());
      await mgr.init();
      await mgr.set("uiLanguage", "ja");
      const last = plugin.saveCalls.at(-1) as SettingsSnapshot;
      // Every key must be present on the persisted snapshot so a future hydrate
      // sees a complete record without falling back to defaults silently.
      const keys = Object.keys(last).sort();
      const defaultKeys = Object.keys(desktopDefaults()).sort();
      expect(keys).toEqual(defaultKeys);
    });
  });
});

// START_CHANGE_SUMMARY
// LAST_CHANGE: 2026-05-13 — initial V-M-SETTINGS-MANAGER scenarios 1–4
// END_CHANGE_SUMMARY
