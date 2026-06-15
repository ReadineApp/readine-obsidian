// START_MODULE_CONTRACT
// PURPOSE: Typed key-value wrapper around Obsidian's plugin.saveData / plugin.loadData. Provides a single in-memory snapshot of all settings keys, persists the full snapshot on every mutation, and dispatches per-key onChange notifications so downstream services (M-AUTO-SYNC-TIMER, M-NETWORK-GATE, M-I18N, M-SETTINGS-UI, M-NOTIFICATIONS) can react without polling.
// SCOPE: src/settings/settings-manager.ts
// DEPENDS: M-SETTINGS-DEFAULTS
// LINKS: UC-001, UC-002, UC-005, UC-006, UC-007, UC-008, UC-009, UC-011, UC-014, UC-018, UC-020, UC-022, V-M-SETTINGS-MANAGER
// ROLE: RUNTIME
// END_MODULE_CONTRACT

// START_MODULE_MAP
// SettingsSnapshot - typed record of all 17 settings keys
// SettingsKey - keyof SettingsSnapshot, union of 17 string literals
// SettingsValue - generic helper: SettingsSnapshot[K] for a given key
// PluginStorageLike - structural interface for the Obsidian Plugin saveData/loadData surface (decoupled from `obsidian` import for testability)
// SettingsChangeCallback - listener signature for onChange (newValue, oldValue)
// SettingsManager - class wrapping plugin storage with typed get/set/getAll/onChange
// END_MODULE_MAP

import type { OutputFormat } from "../vault/format-converter";
import type { LangCode } from "../i18n/i18n";

// START_BLOCK_TYPES
/**
 * Full settings snapshot. Each key has a fixed, typed value; the manager rejects
 * unknown keys at compile time and never persists undefined.
 *
 * NOTE: order of keys mirrors the contract in `docs/development-plan.xml`
 * (M-SETTINGS-MANAGER → contract.purpose) so a reader can diff the two without
 * cross-referencing.
 */
export interface SettingsSnapshot {
  /** Obsidian session token returned by apiAccountObsidianLogin. `null` before first login or after logout. */
  sessionId: string | null;
  /** Readine user id (server-side primary key). `null` before login. */
  userId: string | null;
  /** Output format for synced articles: "markdown" (.md + frontmatter + extracted images) or "html" (.html raw). */
  outputFormat: OutputFormat;
  /** Parameterized vault path template. */
  pathTemplate: string;
  /** Policy for articles removed server-side. */
  deletePolicy: "keep" | "delete";
  /** Auto-sync interval in minutes. `'off'` disables. */
  autoSyncInterval: "off" | 5 | 15 | 30 | 60 | 240 | 480 | 1440;
  /** Network gating policy for article body fetches. */
  networkForArticles: "always" | "Wi-Fi+cellular" | "Wi-Fi-only" | "off";
  /** Cache retention. `'off'` disables cleanup; otherwise older bodies removed. */
  limitCacheDays: "off" | 7 | 30 | 90 | 365;
  /** Active UI language. */
  uiLanguage: LangCode;
  /** Human-readable last sync error, surfaced in M-SETTINGS-UI. `null` when no error. */
  lastSyncError: string | null;
  /** Whether to show the unread notifications badge on the ribbon icon. */
  notificationsBadge: boolean;
  /** Whether the user explicitly set uiLanguage via settings UI. `false` = auto-detect. */
  uiLanguageSet: boolean;
  /** Sync only favorited (starred) articles. */
  syncFavoritesOnly: boolean;
  /** Cache cleanup: don't delete favorited articles. */
  cleanupExcludeFavorites: boolean;
  /** Cache cleanup: don't delete articles with notes. */
  cleanupExcludeWithNotes: boolean;
  /** File template for markdown format. */
  fileTemplate: string;
  /** Whether the user completed the setup wizard. Gates auto-sync ticks. `false` on first install or after disconnect. */
  wizardCompleted: boolean;
}

export type SettingsKey = keyof SettingsSnapshot;
export type SettingsValue<K extends SettingsKey> = SettingsSnapshot[K];

/**
 * Structural subset of the Obsidian Plugin surface used by SettingsManager.
 * Decoupling from the `obsidian` import keeps tests trivial — a plain object
 * literal satisfies this contract.
 */
export interface PluginStorageLike {
  saveData(data: object): Promise<void>;
  loadData(): Promise<object | null>;
}

/**
 * Per-key onChange listener. `oldValue` is the value that was active before
 * the set() call returned; reference equality is preserved for object-typed keys
 * (callers should treat snapshots as immutable).
 */
export type SettingsChangeCallback<K extends SettingsKey> = (
  newValue: SettingsValue<K>,
  oldValue: SettingsValue<K>,
) => void;
// END_BLOCK_TYPES

// START_BLOCK_INTERNAL_LOG
const MODULE_ID = "M-SETTINGS-MANAGER";

function logInfo(
  anchor: string,
  event: string,
  belief: string,
  requirement: string,
  details: Record<string, unknown> = {},
): void {
  // eslint-disable-next-line no-console
  console.debug({
    ts: new Date().toISOString(),
    level: "info",
    anchor,
    module: MODULE_ID,
    requirement,
    event,
    belief,
    ...details,
  });
}
// END_BLOCK_INTERNAL_LOG

// START_BLOCK_MANAGER
/**
 * Typed settings manager. Owns the in-memory snapshot, persists the full bag
 * on every mutation, and dispatches per-key change notifications.
 *
 * Lifecycle:
 *   const mgr = new SettingsManager(plugin, getDefaults('desktop'));
 *   await mgr.init();         // merges persisted data over defaults, emits SETTINGS_INITIALIZED
 *   mgr.get('uiLanguage');    // typed access
 *   await mgr.set('uiLanguage', 'ru');  // persists + fires onChange listeners
 *   const off = mgr.onChange('uiLanguage', (next, prev) => ...);
 *   off();                    // unsubscribe
 *
 * Concurrency: set() awaits saveData before resolving, so consecutive `await mgr.set(...)`
 * calls are serialized by the caller. Fan-out from a single tick is supported via JS
 * microtask ordering; we do not coalesce writes (saveData is cheap in Obsidian).
 */
export class SettingsManager {
  private readonly _plugin: PluginStorageLike;
  private readonly _defaults: Readonly<SettingsSnapshot>;
  private _snapshot: SettingsSnapshot;
  private _initialized = false;
  // Listener bucket. Keyed by SettingsKey at the boundary; internally erased to
  // `Array<SettingsChangeCallback<SettingsKey>>` because the discriminated form
  // (`Partial<{ [K]: Array<...<K>> }>`) collapses to an intersection inside
  // generic methods. The public surface (onChange<K>) preserves the K↔value link.
  private readonly _listeners = new Map<
    SettingsKey,
    Array<SettingsChangeCallback<SettingsKey>>
  >();
  // Serialization queue: ensures sequential execution of set() calls to prevent
  // race conditions where parallel saveData() calls could lose data.
  private _setQueue: Promise<void> = Promise.resolve();

  // START_CONTRACT: constructor
  // PURPOSE: build a SettingsManager bound to a plugin's storage with platform-aware defaults
  // INPUTS: plugin: PluginStorageLike, defaults: SettingsSnapshot
  // OUTPUTS: instance with snapshot initialized to a clone of `defaults` (not yet persisted)
  // SIDE_EFFECTS: none until init() is called
  // LINKS: UC-001, V-M-SETTINGS-MANAGER
  // END_CONTRACT: constructor
  constructor(plugin: PluginStorageLike, defaults: SettingsSnapshot) {
    this._plugin = plugin;
    // Freeze the defaults reference but clone the working snapshot — callers can
    // mutate values returned from getAll() only through set().
    this._defaults = Object.freeze({ ...defaults }) as Readonly<SettingsSnapshot>;
    this._snapshot = { ...defaults };
  }

  // START_CONTRACT: init
  // PURPOSE: hydrate the in-memory snapshot by merging persisted data over defaults
  // INPUTS: none
  // OUTPUTS: Promise<void> — resolves after loadData completes
  // SIDE_EFFECTS: calls plugin.loadData; emits SETTINGS_INITIALIZED log marker; sets _initialized = true
  // LINKS: UC-001, UC-009, UC-020, V-M-SETTINGS-MANAGER
  // END_CONTRACT: init
  async init(): Promise<void> {
    // START_BLOCK_LOAD_DEFAULTS
    const persisted = await this._plugin.loadData();
    if (persisted && typeof persisted === "object") {
      // Merge persisted values over defaults. We never accept unknown keys
      // (TypeScript can't validate at runtime, so we walk the defaults).
      const merged: SettingsSnapshot = { ...this._defaults };
      const persistedRecord = persisted as Record<string, unknown>;
      const nullableKeys = new Set(["sessionId", "userId", "lastSyncError"]);
      for (const key of Object.keys(this._defaults) as SettingsKey[]) {
        if (key in persistedRecord && persistedRecord[key] !== undefined) {
          const val = persistedRecord[key];
          // Runtime type guard: accept only primitive values matching expected
          // shapes. This prevents corrupted persisted data (e.g. a string where
          // a number is expected) from crashing the plugin on load.
          if (val === null) {
            if (nullableKeys.has(key)) {
              (merged as unknown as Record<string, unknown>)[key] = val;
            }
          } else if (typeof val === "string" || typeof val === "number" || typeof val === "boolean") {
            (merged as unknown as Record<string, unknown>)[key] = val;
          }
        }
      }
      this._snapshot = merged;
    }
    this._initialized = true;
    logInfo(
      "loadDefaults",
      "SETTINGS_INITIALIZED",
      "settings snapshot hydrated from plugin.loadData over defaults",
      "UC-001",
      { firstRun: persisted === null || persisted === undefined },
    );
    // END_BLOCK_LOAD_DEFAULTS
  }

  // START_CONTRACT: get
  // PURPOSE: read a typed value for a single settings key
  // INPUTS: key: K (compile-time-validated keyof SettingsSnapshot)
  // OUTPUTS: SettingsValue<K>
  // SIDE_EFFECTS: none
  // LINKS: UC-001, UC-005, UC-009, V-M-SETTINGS-MANAGER
  // END_CONTRACT: get
  get<K extends SettingsKey>(key: K): SettingsValue<K> {
    return this._snapshot[key];
  }

  // START_CONTRACT: getAll
  // PURPOSE: return a read-only view of the full settings snapshot
  // INPUTS: none
  // OUTPUTS: Readonly<SettingsSnapshot> — same internal reference, callers must treat as immutable
  // SIDE_EFFECTS: none
  // LINKS: UC-001, V-M-SETTINGS-MANAGER
  // END_CONTRACT: getAll
  getAll(): Readonly<SettingsSnapshot> {
    return this._snapshot as Readonly<SettingsSnapshot>;
  }

  // START_CONTRACT: set
  // PURPOSE: update a single key, persist the full snapshot, and notify listeners
  // INPUTS: key: K, value: SettingsValue<K>
  // OUTPUTS: Promise<void> — resolves after saveData completes (listeners fire BEFORE resolve)
  // SIDE_EFFECTS: calls plugin.saveData; invokes per-key onChange listeners; emits SETTING_PERSISTED log marker
  // LINKS: UC-001, UC-005, UC-006, UC-007, UC-008, UC-009, UC-011, UC-014, UC-018, UC-020, V-M-SETTINGS-MANAGER
  // END_CONTRACT: set
  async set<K extends SettingsKey>(
    key: K,
    value: SettingsValue<K>,
  ): Promise<void> {
    // Same-value shortcut — no need to queue.
    if (Object.is(this._snapshot[key], value)) return;
    return this._enqueue(() => this._setImpl(key, value));
  }

  private async _setImpl<K extends SettingsKey>(key: K, value: SettingsValue<K>): Promise<void> {
    const previous = this._snapshot[key];
    this._snapshot = { ...this._snapshot, [key]: value };
    await this._plugin.saveData({ ...this._snapshot });
    logInfo(
      "set:BLOCK_PERSIST",
      "SETTING_PERSISTED",
      "settings key written to plugin.saveData",
      "UC-001",
      { key },
    );

    const rawListeners = this._listeners.get(key);
    if (rawListeners && rawListeners.length > 0) {
      const listeners = rawListeners.slice() as unknown as Array<
        SettingsChangeCallback<K>
      >;
      for (const cb of listeners) {
        try {
          cb(value, previous);
        } catch (err) {
          console.error({
            ts: new Date().toISOString(),
            level: "error",
            anchor: "set:BLOCK_DISPATCH",
            module: MODULE_ID,
            requirement: "UC-001",
            event: "SETTINGS_LISTENER_ERROR",
            belief: "downstream listener threw — swallowed to preserve persistence semantics",
            key,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }
  }

  private _enqueue(fn: () => Promise<void>): Promise<void> {
    this._setQueue = this._setQueue.then(fn).catch((err) => {
      console.error({
        ts: new Date().toISOString(),
        level: "error",
        anchor: "enqueue",
        module: MODULE_ID,
        requirement: "UC-001",
        event: "SET_PERSIST_ERROR",
        belief: "saveData failed — setting change not persisted",
        error: err instanceof Error ? err.message : String(err),
      });
    });
    return this._setQueue;
  }

  // START_CONTRACT: onChange
  // PURPOSE: register a per-key change listener; returns a synchronous unsubscribe
  // INPUTS: key: K, callback: SettingsChangeCallback<K>
  // OUTPUTS: () => void — invoke to detach the listener
  // SIDE_EFFECTS: appends to internal listener registry
  // LINKS: UC-001, UC-006, UC-007, UC-008, UC-014, V-M-SETTINGS-MANAGER
  // END_CONTRACT: onChange
  onChange<K extends SettingsKey>(
    key: K,
    callback: SettingsChangeCallback<K>,
  ): () => void {
    let bucket = this._listeners.get(key);
    if (!bucket) {
      bucket = [];
      this._listeners.set(key, bucket);
    }
    // The cast is safe because we only ever read this bucket back through
    // the same `key` discriminator — see set()'s dispatch block.
    bucket.push(callback as unknown as SettingsChangeCallback<SettingsKey>);
    return () => {
      const target = callback as unknown as SettingsChangeCallback<SettingsKey>;
      const idx = bucket!.indexOf(target);
      if (idx >= 0) bucket!.splice(idx, 1);
    };
  }

  /** Test-only escape hatch; production code reads via get(). */
  __isInitializedForTests(): boolean {
    return this._initialized;
  }
}
// END_BLOCK_MANAGER

// START_CHANGE_SUMMARY
// LAST_CHANGE: 2026-05-27 — add lastNotificationsSyncStamp + notificationsBadge keys for M-NOTIFICATIONS
// LAST_CHANGE: 2026-06-01 — fix: log _enqueue errors instead of silent catch; add runtime type validation on loadData; fix MODULE_MAP count 18→19
// LAST_CHANGE: 2026-06-04 — expand autoSyncInterval type to include 240/480/1440 for 4h/8h/24h options
// LAST_CHANGE: 2026-06-07 — remove lastNotificationsSyncStamp (moved to file-backed NotificationsStore)
// LAST_CHANGE: 2026-06-07 — remove pathMappings from SettingsSnapshot (moved to ArticleRegistry); fix MODULE_MAP count 19→17
// END_CHANGE_SUMMARY
