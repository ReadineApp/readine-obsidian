// START_MODULE_CONTRACT
// PURPOSE: Unit tests for M-RIBBON — ribbon icon added on onload, click triggers SyncOrchestrator.triggerSync('manual').
// SCOPE: src/plugin/ribbon.test.ts
// DEPENDS: M-RIBBON, M-SYNC-ORCHESTRATOR, M-I18N
// LINKS: V-M-RIBBON
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
import type { I18n } from "../i18n/i18n-bridge";
import type { SyncOrchestrator, SyncResult } from "../sync/sync-orchestrator";

import { RIBBON_ICON_ID, registerRibbon } from "./ribbon";

interface RibbonCaptured {
  icon: string;
  title: string;
  callback: () => void;
}

const Plugin = MockPlugin as unknown as new () => ObsidianPlugin & {
  _ribbons: RibbonCaptured[];
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

function buildOrchestrator(
  result: SyncResult = {
    success: true,
    written: 1,
    skipped: 0,
    attachmentsDownloaded: 0,
    deleted: 0,
  },
): { service: SyncOrchestrator; triggerSync: ReturnType<typeof vi.fn> } {
  const triggerSync = vi.fn(async (_src: "manual" | "auto") => result);
  return {
    service: { triggerSync } as unknown as SyncOrchestrator,
    triggerSync,
  };
}

async function drainMicrotasks(): Promise<void> {
  for (let i = 0; i < 4; i += 1) {
    await Promise.resolve();
  }
}
// END_BLOCK_FIXTURES

describe("M-RIBBON (V-M-RIBBON)", () => {
  beforeEach(() => {
    __resetObsidianMock();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // scenario-1: ribbon icon added on onload
  // -------------------------------------------------------------------------
  it("scenario-1: registers a ribbon icon with the 'refresh-cw' Lucide glyph and localized tooltip", () => {
    const plugin = new Plugin() as ObsidianPlugin & {
      _ribbons: RibbonCaptured[];
    };
    const orch = buildOrchestrator();
    const notices: string[] = [];

    const el = registerRibbon(plugin, {
      orchestrator: orch.service,
      i18n: I18N_STUB,
      noticeFactory: (m) => notices.push(m),
    });

    // Exactly one ribbon recorded.
    expect(plugin._ribbons).toHaveLength(1);
    const ribbon = plugin._ribbons[0]!;
    expect(ribbon.icon).toBe(RIBBON_ICON_ID);
    expect(ribbon.icon).toBe("refresh-cw");
    expect(ribbon.title).toBe("[ribbon.sync_now]");
    expect(typeof ribbon.callback).toBe("function");
    // The returned HTMLElement reference is non-null (mock provides a real stub div).
    expect(el).toBeDefined();
  });

  // -------------------------------------------------------------------------
  // scenario-2: click triggers SyncOrchestrator.triggerSync('manual')
  // -------------------------------------------------------------------------
  it("scenario-2: invoking the ribbon callback fires orchestrator.triggerSync('manual') and surfaces a Notice", async () => {
    const plugin = new Plugin() as ObsidianPlugin & {
      _ribbons: RibbonCaptured[];
    };
    const orch = buildOrchestrator();
    const notices: string[] = [];

    registerRibbon(plugin, {
      orchestrator: orch.service,
      i18n: I18N_STUB,
      noticeFactory: (m) => notices.push(m),
    });

    const ribbon = plugin._ribbons[0]!;
    ribbon.callback();
    await drainMicrotasks();

    expect(orch.triggerSync).toHaveBeenCalledTimes(1);
    expect(orch.triggerSync).toHaveBeenCalledWith("manual");
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain("[notice.sync_done]");
  });

  // Defensive: orchestrator rejection surfaces failure Notice — never escapes.
  it("orchestrator rejection surfaces the failure Notice key", async () => {
    const plugin = new Plugin() as ObsidianPlugin & {
      _ribbons: RibbonCaptured[];
    };
    const triggerSync = vi.fn(async () => {
      throw new Error("simulated network error");
    });
    const notices: string[] = [];

    registerRibbon(plugin, {
      orchestrator: { triggerSync } as unknown as SyncOrchestrator,
      i18n: I18N_STUB,
      noticeFactory: (m) => notices.push(m),
    });

    const ribbon = plugin._ribbons[0]!;
    expect(() => ribbon.callback()).not.toThrow();
    await drainMicrotasks();
    expect(notices).toEqual(["[notice.sync_failed]"]);
  });

  // Defensive: SyncResult error codes mapped to specific Notice keys.
  it("maps non-success SyncResult.error to dedicated Notice keys", async () => {
    const plugin = new Plugin() as ObsidianPlugin & {
      _ribbons: RibbonCaptured[];
    };
    const orch = buildOrchestrator({
      success: false,
      written: 0,
      skipped: 0,
      attachmentsDownloaded: 0,
      deleted: 0,
      error: "NETWORK_BLOCKED",
    });
    const notices: string[] = [];

    registerRibbon(plugin, {
      orchestrator: orch.service,
      i18n: I18N_STUB,
      noticeFactory: (m) => notices.push(m),
    });

    const ribbon = plugin._ribbons[0]!;
    ribbon.callback();
    await drainMicrotasks();
    expect(notices).toEqual(["[notice.sync_network_blocked]"]);
  });
});

// START_CHANGE_SUMMARY
// LAST_CHANGE: 2026-05-12 — Phase 8 wiring
// END_CHANGE_SUMMARY
