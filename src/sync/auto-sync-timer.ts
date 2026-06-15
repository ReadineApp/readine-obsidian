// START_MODULE_CONTRACT
// PURPOSE: Interval-based trigger for SyncOrchestrator. start() reads autoSyncInterval ('off' | 5 | 15 | 30 | 60 | 240 | 480 | 1440); when not 'off' schedules setInterval at the corresponding ms. Each tick: if AuthService.isReady() → orchestrator.triggerSync('auto').catch(noop); else silent skip. settings.onChange('autoSyncInterval') restarts the timer so changing the setting takes effect immediately. stop() clears the interval. restart() = stop() + start(). On Mobile the OS may suspend the Electron timer; this module makes no platform-specific guarantees about wall-clock accuracy — UC-004 explicitly tolerates skipped ticks when the app is killed.
// SCOPE: src/sync/auto-sync-timer.ts
// DEPENDS: M-SYNC-ORCHESTRATOR, M-SETTINGS-MANAGER, M-AUTH-SERVICE
// LINKS: UC-004, UC-008, V-M-AUTO-SYNC-TIMER
// ROLE: RUNTIME
// MAP_MODE: EXPORTS
// END_MODULE_CONTRACT

// START_MODULE_MAP
// AutoSyncTimerDeps - DI bag: { orchestrator, settings, auth, setInterval?, clearInterval? }
// AutoSyncTimer - class with start / stop / restart / isRunning / isOff
// END_MODULE_MAP

import type { SettingsManager, SettingsValue } from "../settings/settings-manager";
import type { AuthService } from "../auth/auth-service";
import type { SyncOrchestrator } from "./sync-orchestrator";

// START_BLOCK_TYPES
/**
 * Minimal interface over global setInterval / clearInterval so tests can
 * substitute fake timers without dragging Vitest's `vi.useFakeTimers()`
 * into the production code. In Phase 8, the plugin shell will inject
 * `window.setInterval` / `window.clearInterval` (registered via
 * `Plugin.registerInterval` so Obsidian disposes them on plugin unload).
 *
 * The return type is intentionally `unknown` — Node's `Timeout` vs browser's
 * `number` differ; we only ever hand the value back to clearInterval.
 */
export interface AutoSyncTimerDeps {
  orchestrator: SyncOrchestrator;
  settings: SettingsManager;
  auth: AuthService;
  /** Optional override; defaults to the global setInterval. */
  setInterval?: (cb: () => void, ms: number) => unknown;
  /** Optional override; defaults to the global clearInterval. */
  clearInterval?: (handle: unknown) => void;
}
// END_BLOCK_TYPES

// START_BLOCK_INTERNAL_LOG
const MODULE_ID = "M-AUTO-SYNC-TIMER";

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
    requirement: "UC-004",
    event,
    belief,
    ...details,
  });
}
// END_BLOCK_INTERNAL_LOG

const MS_PER_MIN = 60_000;

// START_CONTRACT: AutoSyncTimer
// PURPOSE: drive periodic sync ticks from the autoSyncInterval setting
// INPUTS: deps: AutoSyncTimerDeps
// OUTPUTS: class with start / stop / restart / isRunning / isOff
// SIDE_EFFECTS: schedules / clears interval; subscribes to settings.onChange; emits AUTO_SYNC_TICK / AUTO_SYNC_SKIP markers
// LINKS: UC-004, UC-008, V-M-AUTO-SYNC-TIMER
// END_CONTRACT: AutoSyncTimer
export class AutoSyncTimer {
  private readonly orchestrator: SyncOrchestrator;
  private readonly settings: SettingsManager;
  private readonly auth: AuthService;
  private readonly _setInterval: NonNullable<AutoSyncTimerDeps["setInterval"]>;
  private readonly _clearInterval: NonNullable<AutoSyncTimerDeps["clearInterval"]>;
  private handle: unknown = null;
  private unsubSettings: (() => void) | null = null;

  constructor(deps: AutoSyncTimerDeps) {
    this.orchestrator = deps.orchestrator;
    this.settings = deps.settings;
    this.auth = deps.auth;
    // The casts handle the Node/browser global signature differences. We
    // only ever store the handle as opaque and feed it back unchanged.
    this._setInterval =
      deps.setInterval ?? ((cb, ms) => globalThis.setInterval(cb, ms));
    this._clearInterval =
      deps.clearInterval ??
      ((h) => globalThis.clearInterval(h as ReturnType<typeof setInterval>));
  }

  // START_CONTRACT: start
  // PURPOSE: schedule the interval per current settings.autoSyncInterval and subscribe to changes
  // INPUTS: none
  // OUTPUTS: void
  // SIDE_EFFECTS: schedules setInterval (when not 'off'); registers settings.onChange listener; emits AUTO_SYNC_START log
  // LINKS: UC-004, UC-008, V-M-AUTO-SYNC-TIMER
  // END_CONTRACT: start
  start(): void {
    // Subscribe to setting changes once — repeated start() calls re-attach
    // the same handler, so we guard with a unsubscribe pointer.
    if (this.unsubSettings === null) {
      this.unsubSettings = this.settings.onChange("autoSyncInterval", () => {
        logInfo(
          "start:BLOCK_SUBSCRIBE",
          "AUTO_SYNC_RESTART",
          "autoSyncInterval setting changed — restarting timer",
        );
        this.restart();
      });
    }
    this._schedule();
  }

  // START_CONTRACT: stop
  // PURPOSE: clear the interval and unsubscribe from settings
  // INPUTS: none
  // OUTPUTS: void
  // SIDE_EFFECTS: clearInterval; settings.onChange unsubscribe; emits AUTO_SYNC_STOP log
  // LINKS: UC-004, V-M-AUTO-SYNC-TIMER
  // END_CONTRACT: stop
  stop(): void {
    if (this.handle !== null) {
      this._clearInterval(this.handle);
      this.handle = null;
    }
    if (this.unsubSettings) {
      this.unsubSettings();
      this.unsubSettings = null;
    }
    logInfo(
      "stop",
      "AUTO_SYNC_STOP",
      "interval cleared; settings subscription dropped",
    );
  }

  // START_CONTRACT: restart
  // PURPOSE: stop + re-schedule the timer; used internally on setting change
  // INPUTS: none
  // OUTPUTS: void
  // SIDE_EFFECTS: clears existing interval; re-schedules with the new value; preserves the settings.onChange subscription
  // LINKS: UC-008, V-M-AUTO-SYNC-TIMER
  // END_CONTRACT: restart
  restart(): void {
    if (this.handle !== null) {
      this._clearInterval(this.handle);
      this.handle = null;
    }
    this._schedule();
  }

  /** True while an interval is scheduled. False when autoSyncInterval='off'. */
  isRunning(): boolean {
    return this.handle !== null;
  }

  /** Convenience: true iff the current setting is 'off'. */
  isOff(): boolean {
    return this.settings.get("autoSyncInterval") === "off";
  }

  // START_BLOCK_TICK
  private _schedule(): void {
    const setting: SettingsValue<"autoSyncInterval"> = this.settings.get(
      "autoSyncInterval",
    );
    if (setting === "off") {
      logInfo(
        "start:BLOCK_TICK",
        "AUTO_SYNC_OFF",
        "interval='off' — not scheduling",
      );
      return;
    }
    const intervalMs = setting * MS_PER_MIN;
    this.handle = this._setInterval(() => this._onTick(), intervalMs);
    logInfo(
      "start:BLOCK_TICK",
      "AUTO_SYNC_SCHEDULED",
      "setInterval armed",
      { intervalMs, intervalMin: setting },
    );
  }

  private _onTick(): void {
    // Gate at the auth layer first — saves a NETWORK detect/gate call when
    // the user is logged out. UC-008 says the timer should silently skip on
    // missing auth; the orchestrator would return error='no_auth' anyway,
    // but we avoid lighting up that telemetry path on every tick.
    if (!this.auth.isReady()) {
      logInfo(
        "onTick:BLOCK_GATE",
        "AUTO_SYNC_SKIP",
        "auth not ready — silent skip",
        { reason: "no_auth" },
      );
      return;
    }
    if (!this.settings.get("wizardCompleted")) {
      logInfo(
        "onTick:BLOCK_GATE",
        "AUTO_SYNC_SKIP",
        "wizard not completed — silent skip",
        { reason: "wizard_not_completed" },
      );
      return;
    }
    logInfo(
      "onTick:BLOCK_GATE",
      "AUTO_SYNC_TICK",
      "tick fired — delegating to orchestrator",
    );
    // Fire-and-forget; the orchestrator handles its own debounce + errors.
    // We swallow rejection so a future tick can fire even if this one
    // errored on a non-recoverable internal_error path.
    this.orchestrator.triggerSync("auto").catch((err) => {
      logInfo(
        "onTick:BLOCK_GATE",
        "AUTO_SYNC_TICK_ERROR",
        "orchestrator.triggerSync rejected — swallowed for next tick",
        { error: err instanceof Error ? err.message : String(err) },
      );
    });
  }
  // END_BLOCK_TICK
}

// START_CHANGE_SUMMARY
// LAST_CHANGE: 2026-05-13 — initial Phase 6 M-AUTO-SYNC-TIMER implementation
// LAST_CHANGE: 2026-06-04 — update contract to reflect new autoSyncInterval values (240/480/1440)
// END_CHANGE_SUMMARY
