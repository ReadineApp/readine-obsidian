// START_MODULE_CONTRACT
// PURPOSE: Unit tests for M-COMMANDS — sync-now wired, disconnect wired, full command-palette invocation integration.
// SCOPE: src/plugin/commands.test.ts
// DEPENDS: M-COMMANDS, M-SYNC-ORCHESTRATOR, M-AUTH-SERVICE, M-I18N
// LINKS: V-M-COMMANDS
// ROLE: TEST
// END_MODULE_CONTRACT

// START_MODULE_MAP
// (test file — no public exports)
// END_MODULE_MAP

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => import("../__mocks__/obsidian"));

import {
  Plugin as MockPlugin,
  __resetObsidianMock,
} from "../__mocks__/obsidian";
import type { Plugin as ObsidianPlugin } from "obsidian";
import type { AuthService } from "../auth/auth-service";
import type { I18n } from "../i18n/i18n-bridge";
import type { SyncOrchestrator, SyncResult } from "../sync/sync-orchestrator";

import { CommandIds, registerCommands } from "./commands";

const Plugin = MockPlugin as unknown as new () => ObsidianPlugin & {
  _commands: Array<Record<string, unknown>>;
};

// START_BLOCK_FIXTURES
const I18N_STUB: I18n = {
  t: (key, params) => {
    if (!params) return `[${key}]`;
    let out = `[${key}]`;
    for (const [k, v] of Object.entries(params)) out += ` ${k}=${v}`;
    return out;
  },
  getCurrentLanguage: () => "en",
};

function buildAuth(): {
  service: AuthService;
  logout: ReturnType<typeof vi.fn>;
} {
  const logout = vi.fn(async () => {
    // no-op: production logout clears tokens via SettingsManager
  });
  return {
    service: { logout } as unknown as AuthService,
    logout,
  };
}

function buildOrchestrator(
  result: SyncResult = {
    success: true,
    written: 3,
    skipped: 0,
    attachmentsDownloaded: 2,
    deleted: 0,
  },
): { service: SyncOrchestrator; triggerSync: ReturnType<typeof vi.fn> } {
  const triggerSync = vi.fn(async (_src: "manual" | "auto") => result);
  return {
    service: { triggerSync } as unknown as SyncOrchestrator,
    triggerSync,
  };
}

function buildPlugin(): ObsidianPlugin & {
  _commands: Array<Record<string, unknown>>;
} {
  return new Plugin() as ObsidianPlugin & {
    _commands: Array<Record<string, unknown>>;
  };
}

interface CommandCaptured {
  id: string;
  name: string;
  callback: () => void;
}

function getCommand(
  plugin: ObsidianPlugin & { _commands: Array<Record<string, unknown>> },
  id: string,
): CommandCaptured {
  const cmd = plugin._commands.find((c) => c.id === id);
  if (!cmd) throw new Error(`command not registered: ${id}`);
  return cmd as unknown as CommandCaptured;
}

/** Drain the microtask queue so fire-and-forget Promises settle. */
async function drainMicrotasks(): Promise<void> {
  for (let i = 0; i < 4; i += 1) {
    await Promise.resolve();
  }
}
// END_BLOCK_FIXTURES

describe("M-COMMANDS (V-M-COMMANDS)", () => {
  beforeEach(() => {
    __resetObsidianMock();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // scenario-1: addCommand for sync-now wired
  // -------------------------------------------------------------------------
  it("scenario-1: registers sync-now and invokes orchestrator.triggerSync('manual')", async () => {
    const plugin = buildPlugin();
    const auth = buildAuth();
    const orch = buildOrchestrator();
    const notices: string[] = [];

    registerCommands(plugin, {
      orchestrator: orch.service,
      auth: auth.service,
      i18n: I18N_STUB,
      noticeFactory: (m) => notices.push(m),
    });

    // Command ID, name, and callback are all recorded.
    const cmd = getCommand(plugin, CommandIds.SYNC_NOW);
    expect(cmd.id).toBe("sync-now");
    expect(cmd.name).toBe("[command.sync_now]");
    expect(typeof cmd.callback).toBe("function");

    // Invoke — orchestrator should fire with source='manual'.
    cmd.callback();
    await drainMicrotasks();

    expect(orch.triggerSync).toHaveBeenCalledTimes(1);
    expect(orch.triggerSync).toHaveBeenCalledWith("manual");
    // Notice surfaced with the success template (interpolated written/atts).
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain("[notice.sync_done]");
    expect(notices[0]).toContain("written=3");
    expect(notices[0]).toContain("attachments=2");
  });

  // -------------------------------------------------------------------------
  // scenario-2: addCommand for disconnect wired
  // -------------------------------------------------------------------------
  it("scenario-2: registers disconnect and invokes auth.logout (vault untouched per UC-002)", async () => {
    const plugin = buildPlugin();
    const auth = buildAuth();
    const orch = buildOrchestrator();
    const notices: string[] = [];

    registerCommands(plugin, {
      orchestrator: orch.service,
      auth: auth.service,
      i18n: I18N_STUB,
      noticeFactory: (m) => notices.push(m),
    });

    const cmd = getCommand(plugin, CommandIds.DISCONNECT);
    expect(cmd.id).toBe("disconnect");
    expect(cmd.name).toBe("[command.disconnect]");

    cmd.callback();
    await drainMicrotasks();

    expect(auth.logout).toHaveBeenCalledTimes(1);
    expect(notices).toEqual(["[notice.disconnected]"]);
    // We must NOT have invoked any sync side-effect.
    expect(orch.triggerSync).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // scenario-4: full command-palette invocation integration
  // -------------------------------------------------------------------------
  it("scenario-4: full lifecycle — sync-now and disconnect commands registered with correct ids/names, callbacks fire", async () => {
    const plugin = buildPlugin();
    const auth = buildAuth();
    const orch = buildOrchestrator();
    const notices: string[] = [];

    registerCommands(plugin, {
      orchestrator: orch.service,
      auth: auth.service,
      i18n: I18N_STUB,
      noticeFactory: (m) => notices.push(m),
    });

    // Exactly two commands have been registered.
    expect(plugin._commands).toHaveLength(2);
    expect(plugin._commands.map((c) => c.id)).toEqual([
      "sync-now",
      "disconnect",
    ]);

    // Invoke each command.
    getCommand(plugin, CommandIds.SYNC_NOW).callback();
    await drainMicrotasks();
    getCommand(plugin, CommandIds.DISCONNECT).callback();
    await drainMicrotasks();
    expect(orch.triggerSync).toHaveBeenCalledTimes(1);
    expect(auth.logout).toHaveBeenCalledTimes(1);
    expect(notices).toHaveLength(2);
  });

  // scenario-failure: triggerSync rejection — failure Notice surfaced
  it("orchestrator rejection surfaces failure Notice and never escapes the callback", async () => {
    const plugin = buildPlugin();
    const auth = buildAuth();
    const triggerSync = vi.fn(async () => {
      throw new Error("simulated internal error");
    });
    const notices: string[] = [];

    registerCommands(plugin, {
      orchestrator: { triggerSync } as unknown as SyncOrchestrator,
      auth: auth.service,
      i18n: I18N_STUB,
      noticeFactory: (m) => notices.push(m),
    });

    const cmd = getCommand(plugin, CommandIds.SYNC_NOW);
    // Must NOT throw synchronously even though triggerSync rejects.
    expect(() => cmd.callback()).not.toThrow();
    await drainMicrotasks();
    expect(notices).toEqual(["[notice.sync_failed]"]);
  });

  // failure-path mapping: each error code maps to a specific Notice key
  it("maps non-success SyncResult.error codes to dedicated Notice keys", async () => {
    const plugin = buildPlugin();
    const auth = buildAuth();
    const orch = buildOrchestrator({
      success: false,
      written: 0,
      skipped: 0,
      attachmentsDownloaded: 0,
      deleted: 0,
      error: "no_auth",
    });
    const notices: string[] = [];

    registerCommands(plugin, {
      orchestrator: orch.service,
      auth: auth.service,
      i18n: I18N_STUB,
      noticeFactory: (m) => notices.push(m),
    });

    getCommand(plugin, CommandIds.SYNC_NOW).callback();
    await drainMicrotasks();
    expect(notices).toEqual(["[notice.sync_no_auth]"]);
  });
});

// START_CHANGE_SUMMARY
// LAST_CHANGE: 2026-06-09 — align command ids with src/plugin/commands.ts (removed "readine-" prefix) (DG-Authored: ai)
// END_CHANGE_SUMMARY
