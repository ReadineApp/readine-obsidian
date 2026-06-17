// START_MODULE_CONTRACT
// PURPOSE: Tests for M-AUTO-SYNC-TIMER — interval=30 fires every 30 min (fake timers), interval='off' is a no-op, no-auth ticks silently skip, wizard-not-completed ticks silently skip, settings.onChange triggers restart, integration cycle with fake timers + auth flip.
// SCOPE: src/sync/auto-sync-timer.test.ts
// DEPENDS: M-AUTO-SYNC-TIMER, M-SYNC-ORCHESTRATOR, M-AUTH-SERVICE, M-SETTINGS-MANAGER
// LINKS: V-M-AUTO-SYNC-TIMER
// ROLE: TEST
// END_MODULE_CONTRACT

// START_MODULE_MAP
// (test file — no public exports)
// END_MODULE_MAP

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => import("../__mocks__/obsidian"));

import { __resetObsidianMock } from "../__mocks__/obsidian";
import { SettingsManager } from "../settings/settings-manager";
import { getDefaults } from "../settings/settings-defaults";
import type { AuthService } from "../auth/auth-service";
import type { SyncOrchestrator } from "./sync-orchestrator";
import type { SyncResult } from "./sync-orchestrator";

import { AutoSyncTimer } from "./auto-sync-timer";

async function makeSettings(): Promise<SettingsManager> {
  let store: object | null = null;
  const plugin = {
    saveData: async (data: object) => {
      store = data;
    },
    loadData: async () => store,
  };
  const m = new SettingsManager(plugin, getDefaults("desktop"));
  await m.init();
  return m;
}

function makeAuth(ready: boolean): AuthService {
  return {
    isReady: () => ready,
  } as unknown as AuthService;
}

function makeOrchestratorStub(): {
  service: SyncOrchestrator;
  triggerSync: ReturnType<typeof vi.fn>;
} {
  const triggerSync = vi.fn(async (_src: "manual" | "auto"): Promise<SyncResult> => ({
    success: true,
    written: 0,
    skipped: 0,
    attachmentsDownloaded: 0,
    deleted: 0,
  }));
  return {
    service: { triggerSync } as unknown as SyncOrchestrator,
    triggerSync,
  };
}

describe("M-AUTO-SYNC-TIMER (V-M-AUTO-SYNC-TIMER)", () => {
  beforeEach(() => {
    __resetObsidianMock();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // scenario-1 — interval=30 → triggers every 30 min
  // -------------------------------------------------------------------------
  it("scenario-1: interval=30 → orchestrator triggered every 30 minutes (fake timers)", async () => {
    vi.useFakeTimers();
    const settings = await makeSettings();
    await settings.set("autoSyncInterval", 30);
    await settings.set("wizardCompleted", true);
    const auth = makeAuth(true);
    const orch = makeOrchestratorStub();
    const timer = new AutoSyncTimer({
      orchestrator: orch.service,
      settings,
      auth,
    });
    timer.start();
    // 0 ticks immediately after start.
    expect(orch.triggerSync).toHaveBeenCalledTimes(0);
    // Advance 30 minutes.
    await vi.advanceTimersByTimeAsync(30 * 60 * 1000);
    expect(orch.triggerSync).toHaveBeenCalledTimes(1);
    expect(orch.triggerSync).toHaveBeenLastCalledWith("auto");
    // Another 30 minutes — second tick.
    await vi.advanceTimersByTimeAsync(30 * 60 * 1000);
    expect(orch.triggerSync).toHaveBeenCalledTimes(2);
    timer.stop();
  });

  // -------------------------------------------------------------------------
  // scenario-2 — interval='off' → no-op
  // -------------------------------------------------------------------------
  it("scenario-2: interval='off' → no scheduling, no trigger", async () => {
    vi.useFakeTimers();
    const settings = await makeSettings();
    await settings.set("autoSyncInterval", "off");
    const auth = makeAuth(true);
    const orch = makeOrchestratorStub();
    const timer = new AutoSyncTimer({
      orchestrator: orch.service,
      settings,
      auth,
    });
    timer.start();
    expect(timer.isRunning()).toBe(false);
    expect(timer.isOff()).toBe(true);
    // Advance an hour just to be sure.
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(orch.triggerSync).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // scenario-3 — gating delegated; only auth flagged here
  // -------------------------------------------------------------------------
  it("scenario-3: gating denied at orchestrator → timer still fires (delegation)", async () => {
    // The timer's responsibility is to fire ticks; the orchestrator owns the
    // gating decision. We verify the timer fires regardless of what
    // orchestrator.triggerSync returns.
    vi.useFakeTimers();
    const settings = await makeSettings();
    await settings.set("autoSyncInterval", 5);
    await settings.set("wizardCompleted", true);
    const auth = makeAuth(true);
    const orch = makeOrchestratorStub();
    // Orchestrator simulates network-block; timer still ticks.
    orch.triggerSync.mockImplementation(async () => ({
      success: false,
      written: 0,
      skipped: 0,
      attachmentsDownloaded: 0,
      deleted: 0,
      error: "NETWORK_BLOCKED" as const,
    }));
    const timer = new AutoSyncTimer({
      orchestrator: orch.service,
      settings,
      auth,
    });
    timer.start();
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    expect(orch.triggerSync).toHaveBeenCalledTimes(1);
    timer.stop();
  });

  // -------------------------------------------------------------------------
  // scenario-4 — auth=null → tick silently skips
  // -------------------------------------------------------------------------
  it("scenario-4: auth not ready → tick silently skips orchestrator", async () => {
    vi.useFakeTimers();
    const settings = await makeSettings();
    await settings.set("autoSyncInterval", 5);
    const auth = makeAuth(false);
    const orch = makeOrchestratorStub();
    const timer = new AutoSyncTimer({
      orchestrator: orch.service,
      settings,
      auth,
    });
    timer.start();
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    expect(orch.triggerSync).not.toHaveBeenCalled();
    timer.stop();
  });

  // -------------------------------------------------------------------------
  // scenario-6 — wizard not completed → tick silently skips orchestrator
  // -------------------------------------------------------------------------
  it("scenario-6: wizard not completed → tick silently skips orchestrator", async () => {
    vi.useFakeTimers();
    const settings = await makeSettings();
    await settings.set("autoSyncInterval", 5);
    await settings.set("wizardCompleted", false);
    const auth = makeAuth(true);
    const orch = makeOrchestratorStub();
    const timer = new AutoSyncTimer({
      orchestrator: orch.service,
      settings,
      auth,
    });
    timer.start();
    // Tick should skip — wizard not completed yet
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    expect(orch.triggerSync).not.toHaveBeenCalled();
    // Complete the wizard — next tick should fire
    await settings.set("wizardCompleted", true);
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    expect(orch.triggerSync).toHaveBeenCalledTimes(1);
    expect(orch.triggerSync).toHaveBeenLastCalledWith("auto");
    timer.stop();
  });

  // -------------------------------------------------------------------------
  // scenario-5 — integration: settings.onChange → restart with new interval
  // -------------------------------------------------------------------------
  it("scenario-5: integration — change autoSyncInterval, timer restarts with new period", async () => {
    vi.useFakeTimers();
    const settings = await makeSettings();
    await settings.set("autoSyncInterval", 30);
    await settings.set("wizardCompleted", true);
    const auth = makeAuth(true);
    const orch = makeOrchestratorStub();
    const timer = new AutoSyncTimer({
      orchestrator: orch.service,
      settings,
      auth,
    });
    timer.start();
    // 15 min in — no tick yet (30 min period).
    await vi.advanceTimersByTimeAsync(15 * 60 * 1000);
    expect(orch.triggerSync).toHaveBeenCalledTimes(0);
    // Switch to 5-min interval. The onChange handler restarts the timer.
    await settings.set("autoSyncInterval", 5);
    // 5 min later — tick fires.
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    expect(orch.triggerSync).toHaveBeenCalledTimes(1);
    // Another 5 min — second tick.
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    expect(orch.triggerSync).toHaveBeenCalledTimes(2);
    // Switch to 'off'. No further ticks.
    await settings.set("autoSyncInterval", "off");
    expect(timer.isRunning()).toBe(false);
    await vi.advanceTimersByTimeAsync(30 * 60 * 1000);
    expect(orch.triggerSync).toHaveBeenCalledTimes(2);
    timer.stop();
  });

  // -------------------------------------------------------------------------
  // marker — AUTO_SYNC_TICK on anchor onTick:BLOCK_GATE
  // -------------------------------------------------------------------------
  it("emits AUTO_SYNC_TICK with anchor 'onTick:BLOCK_GATE'", async () => {
    vi.useFakeTimers();
    const settings = await makeSettings();
    await settings.set("autoSyncInterval", 5);
    await settings.set("wizardCompleted", true);
    const auth = makeAuth(true);
    const orch = makeOrchestratorStub();
    const timer = new AutoSyncTimer({
      orchestrator: orch.service,
      settings,
      auth,
    });
    const infoSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    timer.start();
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    const events = infoSpy.mock.calls
      .map((c) => c[0] as Record<string, unknown>)
      .filter((p) => p.module === "M-AUTO-SYNC-TIMER");
    const tick = events.find((p) => p.event === "AUTO_SYNC_TICK");
    expect(tick).toBeDefined();
    expect(tick!.anchor).toBe("onTick:BLOCK_GATE");
    infoSpy.mockRestore();
    timer.stop();
  });

  // -------------------------------------------------------------------------
  // stop is idempotent
  // -------------------------------------------------------------------------
  it("stop() is idempotent — calling twice does not throw", async () => {
    const settings = await makeSettings();
    await settings.set("autoSyncInterval", 30);
    const auth = makeAuth(true);
    const orch = makeOrchestratorStub();
    const timer = new AutoSyncTimer({
      orchestrator: orch.service,
      settings,
      auth,
    });
    timer.start();
    timer.stop();
    expect(() => timer.stop()).not.toThrow();
  });
});

// START_CHANGE_SUMMARY
// LAST_CHANGE: 2026-05-13 — initial test suite for V-M-AUTO-SYNC-TIMER
// END_CHANGE_SUMMARY
