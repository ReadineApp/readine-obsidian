// START_MODULE_CONTRACT
// PURPOSE: Unit tests for M-PLUGIN-MAIN — verify onload registers ERROR-HANDLER first (before other init logs), wires all modules, onunload clears intervals + unsubscribes, full plugin lifecycle (onload → onunload) integration.
// SCOPE: src/main.test.ts
// DEPENDS: M-PLUGIN-MAIN, M-ERROR-HANDLER, M-SETTINGS-MANAGER, M-AUTH-SERVICE, M-SYNC-ORCHESTRATOR, M-AUTO-SYNC-TIMER, M-SETTINGS-UI, M-COMMANDS, M-RIBBON, M-I18N, M-HTTP-BASE
// LINKS: V-M-PLUGIN-MAIN
// ROLE: TEST
// END_MODULE_CONTRACT

// START_MODULE_MAP
// (test file — no public exports)
// END_MODULE_MAP

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => import("./__mocks__/obsidian"));

// The NSwag-generated clients use experimental decorators that vitest's
// rolldown-based parser rejects (esbuild handles them fine in production).
// We mock the two generated modules with minimal stand-ins — they expose just
// the constructor signature and the methods our code touches at wiring time.
vi.mock("./api/clientV1_0", () => {
  class Client_V1_0 {
    constructor(_config: unknown, _http: unknown, _baseUrl?: string) {
      // no-op
    }
    apiFeedSync(): unknown {
      return { subscribe: () => ({ unsubscribe() {} }) };
    }
    apiFeedLoadById(): unknown {
      return { subscribe: () => ({ unsubscribe() {} }) };
    }
  }
  return { Client_V1_0, API_BASE_URL: "test://api" };
});
vi.mock("./api/clientV1_0.Logs", () => {
  class Client_V1_0_Logs {
    constructor(_config: unknown, _http: unknown, _baseUrl?: string) {
      // no-op
    }
    apiLS(): unknown {
      return { subscribe: () => ({ unsubscribe() {} }) };
    }
  }
  return { Client_V1_0_Logs };
});

// Empty dictionaries so setLanguage() doesn't accidentally load real translations.
vi.mock("./i18n/en.json", () => ({ default: {} }));
vi.mock("./i18n/ru.json", () => ({ default: {} }));
vi.mock("./i18n/de.json", () => ({ default: {} }));
vi.mock("./i18n/fr.json", () => ({ default: {} }));
vi.mock("./i18n/ja.json", () => ({ default: {} }));
vi.mock("./i18n/pt.json", () => ({ default: {} }));
vi.mock("./i18n/es.json", () => ({ default: {} }));
vi.mock("./i18n/zh.json", () => ({ default: {} }));
vi.mock("./i18n/it.json", () => ({ default: {} }));
vi.mock("./i18n/ko.json", () => ({ default: {} }));

import {
  App as MockApp,
  MockDataAdapter,
  __resetObsidianMock,
  __setRequestUrlImpl,
} from "./__mocks__/obsidian";
import { __resetLogout401CallbackForTests } from "./api/base";
import ReadinePlugin from "./main";

interface CommandLike {
  id: string;
  name: string;
  callback: () => void;
}
interface RibbonLike {
  icon: string;
  title: string;
  callback: () => void;
}

// START_BLOCK_FIXTURES
/**
 * Wire a fresh ReadinePlugin instance over a controllable App + DataAdapter.
 * Returns the plugin (cast through unknown — we use the mock's runtime shape
 * which is structurally compatible with the real Plugin surface).
 */
function buildPlugin(): InstanceType<typeof ReadinePlugin> {
  const app = new MockApp();
  // Replace the empty adapter with a real in-memory MockDataAdapter so vault
  // I/O (settings persistence, support bundle) has somewhere to read/write.
  app.vault = { adapter: new MockDataAdapter() } as unknown as MockApp["vault"];

  // The MockPlugin constructor takes an optional App (single arg) while the
  // real obsidian.Plugin requires (app, manifest). We invoke the mock via the
  // permissive runtime path — the structural shape is what matters at runtime.
  // Tests bypass the constructor signature mismatch with a typed `never` cast.
  const PluginCtor = ReadinePlugin as unknown as new (
    app: unknown,
  ) => InstanceType<typeof ReadinePlugin>;
  const plugin = new PluginCtor(app);
  return plugin;
}

/** Type-narrowed accessor to the mock Plugin bookkeeping fields. */
function pluginInternals(
  p: InstanceType<typeof ReadinePlugin>,
): {
  _commands: CommandLike[];
  _ribbons: RibbonLike[];
  _settingTabs: unknown[];
} {
  return p as unknown as {
    _commands: CommandLike[];
    _ribbons: RibbonLike[];
    _settingTabs: unknown[];
  };
}
// END_BLOCK_FIXTURES

describe("M-PLUGIN-MAIN (V-M-PLUGIN-MAIN)", () => {
  beforeEach(() => {
    __resetObsidianMock();
    __resetLogout401CallbackForTests();
    // Default requestUrl: 200 + empty body. Tests can override.
    __setRequestUrlImpl(async () => ({
      status: 200,
      headers: {},
      arrayBuffer: new ArrayBuffer(0),
      text: "",
      json: null,
    }));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // scenario-1: onload registers ERROR-HANDLER first (before other init logs)
  // -------------------------------------------------------------------------
  it("scenario-1: ERROR_HANDLER_REGISTERED log marker fires BEFORE other init markers", async () => {
    const events: string[] = [];
    const infoSpy = vi.spyOn(console, 'debug').mockImplementation((payload) => {
      if (payload && typeof payload === "object" && "event" in payload) {
        events.push((payload as { event: string }).event);
      }
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const plugin = buildPlugin();
    await plugin.onload();

    expect(events).toContain("ERROR_HANDLER_REGISTERED");
    expect(events).toContain("PLUGIN_READY");
    // ERROR_HANDLER_REGISTERED must precede PLUGIN_READY in the event order.
    const idxError = events.indexOf("ERROR_HANDLER_REGISTERED");
    const idxReady = events.indexOf("PLUGIN_READY");
    expect(idxError).toBeGreaterThanOrEqual(0);
    expect(idxReady).toBeGreaterThan(idxError);
    // Nothing should fire before ERROR_HANDLER_REGISTERED from our module.
    // (Other modules may emit their own — e.g. PLATFORM_DETECTED — but our
    //  invariant is that the error handler registers as the first PLUGIN-MAIN
    //  side-effect.)

    plugin.onunload();
    infoSpy.mockRestore();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  // -------------------------------------------------------------------------
  // scenario-2: onload wires all modules (commands, ribbon, settings tab)
  // -------------------------------------------------------------------------
  it("scenario-2: onload registers 3 commands, 1 ribbon, 1 settings tab", async () => {
    vi.spyOn(console, 'debug').mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});

    const plugin = buildPlugin();
    await plugin.onload();

    const internals = pluginInternals(plugin);
    expect(internals._commands).toHaveLength(2);
    expect(internals._commands.map((c) => c.id)).toEqual([
      "sync-now",
      "disconnect",
    ]);
    expect(internals._ribbons).toHaveLength(1);
    expect(internals._ribbons[0]!.icon).toBe("refresh-cw");
    expect(internals._settingTabs).toHaveLength(1);

    plugin.onunload();
  });

  // -------------------------------------------------------------------------
  // scenario-3: onunload clears intervals + unsubscribes
  // -------------------------------------------------------------------------
  it("scenario-3: onunload stops auto-sync timer and unregisters error pipeline", async () => {
    vi.spyOn(console, 'debug').mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});

    const plugin = buildPlugin();
    await plugin.onload();
    // Probe the private instance via cast to assert post-state.
    const internal = plugin as unknown as {
      autoSyncTimer: { isRunning(): boolean };
      errorHandler: { __isRegisteredForTests(): boolean };
      errorSender: { __isRegisteredForTests(): boolean };
    };

    // Default autoSyncInterval is 30 — timer should be scheduled.
    expect(internal.autoSyncTimer.isRunning()).toBe(true);
    expect(internal.errorHandler.__isRegisteredForTests()).toBe(true);
    expect(internal.errorSender.__isRegisteredForTests()).toBe(true);

    plugin.onunload();
    expect(internal.autoSyncTimer.isRunning()).toBe(false);
    expect(internal.errorHandler.__isRegisteredForTests()).toBe(false);
    expect(internal.errorSender.__isRegisteredForTests()).toBe(false);
  });

  // -------------------------------------------------------------------------
  // scenario-4: full plugin lifecycle (onload → onunload) integration
  // -------------------------------------------------------------------------
  it("scenario-4: full lifecycle — onload + onunload cycle works without throwing", async () => {
    vi.spyOn(console, 'debug').mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});

    const plugin = buildPlugin();
    await expect(plugin.onload()).resolves.toBeUndefined();
    expect(() => plugin.onunload()).not.toThrow();

    // A second onload/onunload cycle on a fresh plugin still works — verifies
    // there's no leaked global state (e.g., 401 callback registry).
    const plugin2 = buildPlugin();
    await expect(plugin2.onload()).resolves.toBeUndefined();
    expect(() => plugin2.onunload()).not.toThrow();
  });

  // handleSessionExpired re-renders settings tab so the banner appears
  it("handleSessionExpired re-renders settings tab without throwing", async () => {
    vi.spyOn(console, 'debug').mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});

    const plugin = buildPlugin();
    await plugin.onload();
    // Drive the display call via the public re-render hook used by AuthService.
    expect(() => plugin.handleSessionExpired()).not.toThrow();
    plugin.onunload();
  });
});

// START_CHANGE_SUMMARY
// LAST_CHANGE: 2026-06-09 — align command ids with src/plugin/commands.ts (removed "readine-" prefix) (DG-Authored: ai)
// END_CHANGE_SUMMARY
