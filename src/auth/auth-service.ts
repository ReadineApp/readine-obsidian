// START_MODULE_CONTRACT
// PURPOSE: Session/token lifecycle service. login(code) exchanges the Obsidian auth-code for a sessionToken via M-HTTP-CLIENT and persists {sessionId, userId} through M-SETTINGS-MANAGER; logout() and logout401() clear that pair WITHOUT touching the vault (UC-015 invariant). getApiToken() exposes a load-once cached promise consumed by M-HTTP-BASE.transformOptions. Reactive auth-event Subject lets downstream services (auto-sync, settings-ui) react to disconnect / session-expired without polling. Registers itself on construction as the module-level 401 callback in M-HTTP-BASE via registerLogout401Callback — callback inversion breaks the import cycle.
// SCOPE: src/auth/auth-service.ts
// DEPENDS: M-SETTINGS-MANAGER, M-HTTP-CLIENT, M-HTTP-BASE, M-I18N
// LINKS: UC-001, UC-002, UC-015, V-M-AUTH-SERVICE
// ROLE: RUNTIME
// END_MODULE_CONTRACT

// START_MODULE_MAP
// AuthEvent - discriminated union emitted on the events Subject
// AuthEventKind - union of event kind string-literals
// LoginOutcome - return shape of login()
// AuthApiClient - structural slice of NSwag-generated Client_V1_0 actually used here
// AuthService - main class: init / login / logout / logout401 / getApiToken / isReady / getUserId / subscribe
// AuthServiceDeps - DI bag accepted by the constructor
// AuthLoginBody - request DTO sent to apiAccountObsidianLogin (mirrors NSwag wire shape)
// AuthLoginResult - response DTO returned by apiAccountObsidianLogin (sessionToken + userId)
// UnsubscribeFn - typedef for the subscribe() return handle (() => void)
// END_MODULE_MAP

import { Observable, Subject, firstValueFrom } from "rxjs";
import { take } from "rxjs/operators";

import type { SettingsManager } from "../settings/settings-manager";
import { registerLogout401Callback } from "../api/base";
import type { I18n } from "../i18n/i18n-bridge";
import type { DsType } from "../constants";

// START_BLOCK_CONSTANTS
const MODULE_ID = "M-AUTH-SERVICE";

/** API path-fragment hints used only for log/event correlation. */
const I18N_KEY_NO_SUBSCRIPTION = "auth.error.no_subscription";
const I18N_KEY_INVALID_CODE = "auth.error.invalid_code";
const I18N_KEY_NETWORK_ERROR = "auth.error.network_error";
// END_BLOCK_CONSTANTS

// START_BLOCK_TYPES
/**
 * Discriminated union of events emitted on the internal RxJS Subject. Downstream
 * services (auto-sync timer, settings UI, ribbon) subscribe via {@link AuthService.subscribe}
 * to react to the auth lifecycle without poking the SettingsManager directly.
 */
export type AuthEventKind =
  | "auth.login_success"
  | "auth.disconnected"
  | "session-expired"
  | "auth.ready";

export interface AuthEvent {
  kind: AuthEventKind;
  /** Epoch-ms timestamp captured at emit time. */
  ts: number;
  /** Optional userId snapshot — null when cleared. */
  userId?: string | null;
}

/** Outcome of {@link AuthService.login}. */
export interface LoginOutcome {
  ok: boolean;
  userId?: string;
  /** Localized, user-facing error message. Defined iff ok=false. */
  error?: string;
  /** Stable code for logs / telemetry. */
  errorCode?: "NO_SUBSCRIPTION" | "INVALID_CODE" | "NETWORK_ERROR";
}

/**
 * Structural slice of the NSwag-generated Client_V1_0 — only the methods that
 * M-AUTH-SERVICE consumes. Decouples the test surface from the 8 000-line
 * generated client and keeps the dependency one-way (no import of the class
 * itself, only its capabilities).
 */
export interface AuthApiClient {
  apiAccountObsidianLogin(body?: any): Observable<AuthLoginResult>;
  apiAccountLogout(): Observable<boolean>;
}

export interface AuthLoginBody {
  code: string;
  clientVersion: string;
  /** Format: "obsdsktp" or "obsmob". See getPlatformLabel(). */
  platform: string;
  /** Device signature — always "obsidian". See DS constant. */
  ds: DsType;
}

export interface AuthLoginResult {
  sessionToken?: string;
  userId?: string;
}

/**
 * DI bag consumed by the constructor. Bundles the four collaborators so the
 * call-site can write a single object literal — keeps the test scaffolding
 * (and the future M-PLUGIN-MAIN wiring) compact.
 */
export interface AuthServiceDeps {
  settings: SettingsManager;
  apiClient: AuthApiClient;
  /** Observer-pattern hook fired in addition to the events Subject on logout401. */
  onSessionExpired: () => void;
  /** i18n bridge — currently only provides t(key, params?). */
  i18n: I18n;
  /** Optional override for the registerLogout401Callback wiring; test-only. */
  registerLogout401?: (cb: () => void) => void;
  /** Plugin semver from manifest.json — forwarded to LoginByObsidianCode payload. */
  clientVersion: string;
  /** Platform label — use getPlatformLabel() from constants.ts. */
  platform: string;
  /** Device signature — use DS from constants.ts. */
  ds: DsType;
}

/** Unsubscribe handle returned by {@link AuthService.subscribe}. */
export type UnsubscribeFn = () => void;
// END_BLOCK_TYPES

// START_BLOCK_INTERNAL_LOG
/**
 * Lightweight structured logger. Mirrors the canonical format from AGENTS.md
 * (ts/level/anchor/module/requirement/event/belief). Tests assert on these
 * markers per V-M-AUTH-SERVICE.
 */
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

function logWarn(
  anchor: string,
  event: string,
  belief: string,
  requirement: string,
  details: Record<string, unknown> = {},
): void {
  // eslint-disable-next-line no-console
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

// START_BLOCK_AUTH_SERVICE
/**
 * Token lifecycle service. Single-instance, owned by M-PLUGIN-MAIN.
 *
 *   const auth = new AuthService({...});
 *   await auth.init();          // wires 401-callback, hydrates from settings
 *   const r = await auth.login(code);
 *   if (r.ok) ...
 *
 * INVARIANTS:
 *   - logout()/logout401() never touch the vault (UC-015 — only sessionId/userId
 *     cleared via SettingsManager).
 *   - getApiToken() reads through a memo Promise that resolves once init() has
 *     run; consumer code (HTTP-BASE) may safely call before login completes.
 *   - 401 callback is registered exactly once per AuthService instance during init().
 */
export class AuthService {
  private readonly deps: AuthServiceDeps;
  private readonly events$ = new Subject<AuthEvent>();
  private tokenLoadPromise: Promise<string | null> | null = null;
  private inMemoryToken: string | null = null;
  private inMemoryUserId: string | null = null;
  private initialized = false;

  // START_CONTRACT: constructor
  // PURPOSE: build an AuthService bound to its four collaborators
  // INPUTS: deps: AuthServiceDeps
  // OUTPUTS: instance; init() must be called before any other method
  // SIDE_EFFECTS: none until init()
  // LINKS: UC-001, V-M-AUTH-SERVICE
  // END_CONTRACT: constructor
  constructor(deps: AuthServiceDeps) {
    this.deps = deps;
  }

  // START_CONTRACT: init
  // PURPOSE: hydrate sessionId/userId from M-SETTINGS-MANAGER and register the 401 callback in M-HTTP-BASE
  // INPUTS: none
  // OUTPUTS: Promise<void>
  // SIDE_EFFECTS: reads sessionId/userId via settings.get; calls registerLogout401Callback(() => this.logout401()); flips initialized=true
  // LINKS: UC-001, UC-015, V-M-AUTH-SERVICE
  // END_CONTRACT: init
  async init(): Promise<void> {
    // START_BLOCK_HYDRATE
    this.inMemoryToken = this.deps.settings.get("sessionId");
    this.inMemoryUserId = this.deps.settings.get("userId");
    this.tokenLoadPromise = Promise.resolve(this.inMemoryToken);
    this.initialized = true;
    // END_BLOCK_HYDRATE

    // START_BLOCK_REGISTER_401
    const register = this.deps.registerLogout401 ?? registerLogout401Callback;
    register(() => this.logout401());
    logInfo(
      "init:BLOCK_REGISTER_401",
      "AUTH_INIT",
      "401 logout callback registered with HTTP-BASE; in-memory token hydrated",
      "UC-001",
      { hasToken: typeof this.inMemoryToken === "string" && this.inMemoryToken.length > 0 },
    );
    // END_BLOCK_REGISTER_401

    if (this.inMemoryToken && this.inMemoryToken.length > 0) {
      this.events$.next({
        kind: "auth.ready",
        ts: Date.now(),
        userId: this.inMemoryUserId,
      });
    }
  }

  // START_CONTRACT: login
  // PURPOSE: exchange a one-shot Obsidian auth-code for a sessionToken via apiAccountObsidianLogin
  // INPUTS: code: string
  // OUTPUTS: Promise<LoginOutcome> — ok=true with userId on success; ok=false + localized error otherwise
  // SIDE_EFFECTS: POSTs login payload; on success persists sessionId+userId via settings.set; emits 'auth.login_success' on events stream
  // LINKS: UC-001, V-M-AUTH-SERVICE
  // END_CONTRACT: login
  async login(code: string): Promise<LoginOutcome> {
    if (!this.initialized) {
      // Defensive — login before init() is a wiring bug. We don't throw because
      // the plugin shell may surface this in the UI; instead we return a typed
      // failure outcome.
      return {
        ok: false,
        error: this.deps.i18n.t(I18N_KEY_NETWORK_ERROR),
        errorCode: "NETWORK_ERROR",
      };
    }

    // START_BLOCK_EXCHANGE_CODE
    logInfo(
      "login:BLOCK_EXCHANGE_CODE",
      "AUTH_LOGIN_REQUEST",
      "exchanging Obsidian auth-code for sessionToken",
      "UC-001",
      { codeLen: typeof code === "string" ? code.length : 0 },
    );

    const body: AuthLoginBody = {
      code,
      clientVersion: this.deps.clientVersion,
      platform: this.deps.platform,
      ds: this.deps.ds,
    };

    let result: AuthLoginResult;
    try {
      result = await firstValueFrom(
        this.deps.apiClient.apiAccountObsidianLogin(body).pipe(take(1)),
      );
    } catch (err: unknown) {
      const errorCode = classifyLoginError(err);
      const i18nKey = errorCodeToI18nKey(errorCode);
      const message = this.deps.i18n.t(i18nKey);
      const errResponse =
        typeof err === "object" && err !== null && "response" in err
          ? (err as { response: unknown }).response
          : undefined;
      logWarn(
        "login:BLOCK_EXCHANGE_CODE",
        "AUTH_LOGIN_FAIL",
        "login request rejected",
        "UC-001",
        {
          errorCode,
          status: getStatus(err),
          errMessage: err instanceof Error ? err.message : String(err),
          errResponse,
        },
      );
      return { ok: false, error: message, errorCode };
    }
    // END_BLOCK_EXCHANGE_CODE

    // START_BLOCK_PERSIST_TOKEN
    const sessionToken = typeof result?.sessionToken === "string" ? result.sessionToken : "";
    const userId = typeof result?.userId === "string" ? result.userId : "";
    if (sessionToken.length === 0 || userId.length === 0) {
      // Server returned 200 with empty result — treat as invalid code.
      logWarn(
        "login:BLOCK_PERSIST_TOKEN",
        "AUTH_LOGIN_FAIL",
        "200 with empty sessionToken/userId",
        "UC-001",
      );
      return {
        ok: false,
        error: this.deps.i18n.t(I18N_KEY_INVALID_CODE),
        errorCode: "INVALID_CODE",
      };
    }

    this.inMemoryToken = sessionToken;
    this.inMemoryUserId = userId;
    this.tokenLoadPromise = Promise.resolve(sessionToken);
    await this.deps.settings.set("sessionId", sessionToken);
    await this.deps.settings.set("userId", userId);
    await this.deps.settings.set("lastSyncError", null);
    logInfo(
      "login:BLOCK_PERSIST_TOKEN",
      "AUTH_LOGIN_SUCCESS",
      "sessionId+userId persisted via SettingsManager",
      "UC-001",
      { userId },
    );

    this.events$.next({ kind: "auth.login_success", ts: Date.now(), userId });
    this.events$.next({ kind: "auth.ready", ts: Date.now(), userId });
    return { ok: true, userId };
    // END_BLOCK_PERSIST_TOKEN
  }

  // START_CONTRACT: logout
  // PURPOSE: user-initiated disconnect — clear token+userId, emit 'auth.disconnected'; NO vault writes (UC-002 invariant)
  // INPUTS: none
  // OUTPUTS: Promise<void>
  // SIDE_EFFECTS: settings.set('sessionId', null); settings.set('userId', null); emits AuthEvent on events stream
  // LINKS: UC-002, V-M-AUTH-SERVICE
  // END_CONTRACT: logout
  async logout(): Promise<void> {
    // START_BLOCK_CLEAR
    await this.clearTokens("logout");
    this.events$.next({ kind: "auth.disconnected", ts: Date.now(), userId: null });
    // END_BLOCK_CLEAR
  }

  // START_CONTRACT: logout401
  // PURPOSE: server-initiated disconnect (HTTP 401) — invoked via M-HTTP-BASE callback registry; same as logout() PLUS emits 'session-expired' and calls deps.onSessionExpired
  // INPUTS: none
  // OUTPUTS: void — fire-and-forget (the HTTP-BASE callback signature is sync)
  // SIDE_EFFECTS: clears tokens; emits 'session-expired'; invokes deps.onSessionExpired; NO vault writes
  // LINKS: UC-015, V-M-AUTH-SERVICE
  // END_CONTRACT: logout401
  logout401(): void {
    // START_BLOCK_CLEAR_401
    // Fire-and-forget clearTokens; HTTP-BASE expects a sync callback. We do not
    // await — the callback contract is "best-effort persistence." Settings ops
    // are tiny and the next sync tick will see the cleared state regardless.
    void this.clearTokens("logout401");
    this.events$.next({ kind: "session-expired", ts: Date.now(), userId: null });
    try {
      this.deps.onSessionExpired();
    } catch (err: unknown) {
      // Observer must not abort the cascade.
      logWarn(
        "logout401:BLOCK_CLEAR_401",
        "AUTH_OBSERVER_ERROR",
        "onSessionExpired callback threw — swallowed",
        "UC-015",
        { err: err instanceof Error ? err.message : String(err) },
      );
    }
    // END_BLOCK_CLEAR_401
  }

  // START_CONTRACT: getApiToken
  // PURPOSE: provide the AuthId header value for M-HTTP-BASE.transformOptions
  // INPUTS: none
  // OUTPUTS: Promise<string | null> — resolved value of the load-once memo
  // SIDE_EFFECTS: none on subsequent calls (memoized); first call awaits init()
  // LINKS: UC-001, V-M-AUTH-SERVICE
  // END_CONTRACT: getApiToken
  async getApiToken(): Promise<string | null> {
    if (this.tokenLoadPromise === null) {
      // init() not called yet — fall back to the SettingsManager directly,
      // memoize the result so subsequent calls are O(1).
      this.tokenLoadPromise = Promise.resolve(this.deps.settings.get("sessionId"));
    }
    return this.tokenLoadPromise;
  }

  // START_CONTRACT: isReady
  // PURPOSE: synchronous "is the user logged in" probe
  // INPUTS: none
  // OUTPUTS: boolean — true iff init() completed AND a non-empty token is in memory
  // SIDE_EFFECTS: none
  // LINKS: UC-001, V-M-AUTH-SERVICE
  // END_CONTRACT: isReady
  isReady(): boolean {
    return (
      this.initialized &&
      typeof this.inMemoryToken === "string" &&
      this.inMemoryToken.length > 0
    );
  }

  // START_CONTRACT: getUserId
  // PURPOSE: snapshot accessor for the current user identifier
  // INPUTS: none
  // OUTPUTS: string | null
  // SIDE_EFFECTS: none
  // LINKS: UC-001, UC-019, V-M-AUTH-SERVICE
  // END_CONTRACT: getUserId
  getUserId(): string | null {
    return this.inMemoryUserId;
  }

  getSessionId(): string | null {
    return this.inMemoryToken;
  }

  // START_CONTRACT: subscribe
  // PURPOSE: attach an external callback to the auth-event Subject
  // INPUTS: cb: (event: AuthEvent) => void
  // OUTPUTS: UnsubscribeFn — invoke to detach
  // SIDE_EFFECTS: adds an RxJS subscription
  // LINKS: UC-001, UC-002, UC-015, V-M-AUTH-SERVICE
  // END_CONTRACT: subscribe
  subscribe(cb: (event: AuthEvent) => void): UnsubscribeFn {
    const sub = this.events$.subscribe((value) => {
      try {
        cb(value);
      } catch (err: unknown) {
        logWarn(
          "subscribe",
          "AUTH_LISTENER_ERROR",
          "external subscriber threw",
          "UC-001",
          { err: err instanceof Error ? err.message : String(err) },
        );
      }
    });
    return () => sub.unsubscribe();
  }

  /**
   * Read-only events observable. Exported for advanced consumers that want
   * RxJS-style pipe() composition. The {@link subscribe} method is the
   * recommended façade for ordinary call-sites.
   */
  getEvents(): Observable<AuthEvent> {
    return this.events$.asObservable();
  }

  // Internal — shared by logout()/logout401(). Logs once with the originating anchor.
  private async clearTokens(origin: "logout" | "logout401"): Promise<void> {
    this.inMemoryToken = null;
    this.inMemoryUserId = null;
    this.tokenLoadPromise = Promise.resolve(null);
    try {
      if (origin === "logout401") {
        // Mark error FIRST: if clearing sessionId fails, lastSyncError is still set
        await this.deps.settings.set("lastSyncError", "session_expired");
        await this.deps.settings.set("sessionId", null);
        await this.deps.settings.set("userId", null);
      } else {
        await this.deps.settings.set("sessionId", null);
        await this.deps.settings.set("userId", null);
        await this.deps.settings.set("wizardCompleted", false);
        await this.deps.settings.set("lastSyncError", null);
      }
    } catch (err: unknown) {
      logWarn(
        `${origin}:BLOCK_CLEAR`,
        "AUTH_CLEAR_FAIL",
        "SettingsManager.set failed while clearing tokens",
        origin === "logout401" ? "UC-015" : "UC-002",
        { err: err instanceof Error ? err.message : String(err) },
      );
    }
    logInfo(
      `${origin}:BLOCK_CLEAR`,
      "AUTH_TOKEN_CLEARED",
      "sessionId + userId cleared via SettingsManager; vault untouched",
      origin === "logout401" ? "UC-015" : "UC-002",
    );
  }
}
// END_BLOCK_AUTH_SERVICE

// START_BLOCK_ERROR_CLASSIFY
/**
 * Map a raw error (likely an HttpResponseBase-like from the NSwag client) onto
 * one of three buckets. The actual server uses payload codes / status codes;
 * we infer best-effort and degrade gracefully (network-error is the catch-all).
 */
function classifyLoginError(
  err: unknown,
): "NO_SUBSCRIPTION" | "INVALID_CODE" | "NETWORK_ERROR" {
  const status = getStatus(err);
  if (status === 402 || status === 403) return "NO_SUBSCRIPTION";
  if (status === 400 || status === 404) return "INVALID_CODE";
  return "NETWORK_ERROR";
}

function getStatus(err: unknown): number | undefined {
  if (err && typeof err === "object" && "status" in err) {
    const v = (err as { status?: unknown }).status;
    if (typeof v === "number") return v;
  }
  return undefined;
}

function errorCodeToI18nKey(
  code: "NO_SUBSCRIPTION" | "INVALID_CODE" | "NETWORK_ERROR",
): string {
  switch (code) {
    case "NO_SUBSCRIPTION":
      return I18N_KEY_NO_SUBSCRIPTION;
    case "INVALID_CODE":
      return I18N_KEY_INVALID_CODE;
    case "NETWORK_ERROR":
    default:
      return I18N_KEY_NETWORK_ERROR;
  }
}
// END_BLOCK_ERROR_CLASSIFY

// START_CHANGE_SUMMARY
// LAST_CHANGE: 2026-05-13 — initial implementation per Phase 4
// LAST_CHANGE: 2026-06-02 — add errMessage to login error log for better diagnostics
// END_CHANGE_SUMMARY
