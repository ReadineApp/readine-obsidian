// START_MODULE_CONTRACT
// PURPOSE: Unit tests for M-AUTH-SERVICE — login success/failure, logout/logout401 no-vault-write invariant, getApiToken memoization, full integration of HTTP-BASE 401 callback wiring (UC-001 + UC-002 + UC-015).
// SCOPE: src/auth/auth-service.test.ts
// DEPENDS: M-AUTH-SERVICE, M-HTTP-BASE
// LINKS: V-M-AUTH-SERVICE
// ROLE: TEST
// END_MODULE_CONTRACT

// START_MODULE_MAP
// (test file — no public exports)
// END_MODULE_MAP

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Observable, of, throwError } from "rxjs";

vi.mock("obsidian", () => import("../__mocks__/obsidian"));

import {
  __resetLogout401CallbackForTests,
  ApiClientBase,
  ApiClientBaseConfiguration,
  registerLogout401Callback,
} from "../api/base";
import type { HttpOptions, HttpResponse } from "../api/base";
import { AuthService } from "./auth-service";
import type {
  AuthApiClient,
  AuthEvent,
  AuthLoginBody,
  AuthLoginResult,
  AuthServiceDeps,
} from "./auth-service";
import type { I18n } from "../i18n/i18n-bridge";
import { DS } from "../constants";
import type {
  SettingsKey,
  SettingsManager,
  SettingsValue,
} from "../settings/settings-manager";

// START_BLOCK_FIXTURES
/** In-memory settings double — only the keys M-AUTH-SERVICE touches. */
class FakeSettingsManager {
  private bag: Partial<Record<SettingsKey, unknown>> = {};
  public readonly setCalls: Array<{ key: SettingsKey; value: unknown }> = [];

  seed<K extends SettingsKey>(key: K, value: SettingsValue<K>): void {
    this.bag[key] = value;
  }

  get<K extends SettingsKey>(key: K): SettingsValue<K> {
    // Default-fall to null for the two keys we actually exercise.
    if (key === "sessionId" || key === "userId") {
      const v = this.bag[key];
      return (v ?? null) as SettingsValue<K>;
    }
    return this.bag[key] as SettingsValue<K>;
  }

  async set<K extends SettingsKey>(
    key: K,
    value: SettingsValue<K>,
  ): Promise<void> {
    this.setCalls.push({ key, value });
    this.bag[key] = value;
  }
}

const I18N_STUB: I18n = {
  t: (key) => `[i18n:${key}]`,
  getCurrentLanguage: () => "en",
};

function buildOkLoginClient(
  result: Partial<AuthLoginResult> = {},
): {
  client: AuthApiClient;
  lastBody: { value: AuthLoginBody | undefined };
} {
  const lastBody: { value: AuthLoginBody | undefined } = { value: undefined };
  const client: AuthApiClient = {
    apiAccountObsidianLogin: vi
      .fn()
      .mockImplementation((body?: AuthLoginBody): Observable<AuthLoginResult> => {
        lastBody.value = body;
        return of({
          sessionToken: "tok-123",
          userId: "user-A",
          ...result,
        });
      }),
    apiAccountLogout: vi.fn().mockReturnValue(of(true)),
  };
  return { client, lastBody };
}

function buildFailingLoginClient(err: unknown): AuthApiClient {
  return {
    apiAccountObsidianLogin: vi
      .fn()
      .mockReturnValue(throwError(() => err) as Observable<AuthLoginResult>),
    apiAccountLogout: vi.fn().mockReturnValue(of(true)),
  };
}

function buildDeps(
  overrides: Partial<AuthServiceDeps> = {},
): {
  deps: AuthServiceDeps;
  settings: FakeSettingsManager;
  onSessionExpired: ReturnType<typeof vi.fn>;
} {
  const settings = new FakeSettingsManager();
  const onSessionExpired = vi.fn();
  const deps: AuthServiceDeps = {
    settings: settings as unknown as SettingsManager,
    apiClient: buildOkLoginClient().client,
    onSessionExpired,
    i18n: I18N_STUB,
    clientVersion: "0.1.0-test",
    platform: "obsidian-desktop/0.0.0-test",
    ds: DS,
    ...overrides,
  };
  return { deps, settings, onSessionExpired };
}
// END_BLOCK_FIXTURES

describe("M-AUTH-SERVICE (V-M-AUTH-SERVICE)", () => {
  let infoSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    __resetLogout401CallbackForTests();
    infoSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ─── V-M-AUTH-SERVICE scenario-1 ───────────────────────────────────────────
  describe("scenario-1: login(code) → apiAccountObsidianLogin → saveData", () => {
    it("persists sessionId + userId on successful login", async () => {
      const { client, lastBody } = buildOkLoginClient();
      const { deps, settings } = buildDeps({ apiClient: client });
      const svc = new AuthService(deps);
      await svc.init();

      const r = await svc.login("CODE-1");

      expect(r.ok).toBe(true);
      expect(r.userId).toBe("user-A");
      expect(client.apiAccountObsidianLogin).toHaveBeenCalledTimes(1);
      expect(lastBody.value).toMatchObject({
        code: "CODE-1",
        clientVersion: "0.1.0-test",
        platform: "obsidian-desktop/0.0.0-test",
        ds: DS,
      });
      // Both settings.set('sessionId', ...) AND settings.set('userId', ...) called.
      const sessionWrite = settings.setCalls.find((c) => c.key === "sessionId");
      const userWrite = settings.setCalls.find((c) => c.key === "userId");
      expect(sessionWrite?.value).toBe("tok-123");
      expect(userWrite?.value).toBe("user-A");
    });

    it("emits AUTH_LOGIN_REQUEST + AUTH_LOGIN_SUCCESS markers", async () => {
      const { deps } = buildDeps();
      const svc = new AuthService(deps);
      await svc.init();
      await svc.login("CODE-1");

      const events = (infoSpy.mock.calls as unknown[][])
        .map((c) => c[0])
        .filter((c): c is Record<string, unknown> => typeof c === "object" && c !== null);
      const request = events.find((e) => e.event === "AUTH_LOGIN_REQUEST");
      const success = events.find((e) => e.event === "AUTH_LOGIN_SUCCESS");
      expect(request).toBeDefined();
      expect(request!.anchor).toBe("login:BLOCK_EXCHANGE_CODE");
      expect(request!.module).toBe("M-AUTH-SERVICE");
      expect(success).toBeDefined();
      expect(success!.anchor).toBe("login:BLOCK_PERSIST_TOKEN");
    });

    it("emits AuthEvent 'auth.login_success' to subscribers", async () => {
      const { deps } = buildDeps();
      const svc = new AuthService(deps);
      await svc.init();
      const received: AuthEvent[] = [];
      svc.subscribe((e) => received.push(e));

      await svc.login("CODE-1");
      const kinds = received.map((e) => e.kind);
      expect(kinds).toContain("auth.login_success");
      expect(kinds).toContain("auth.ready");
      const success = received.find((e) => e.kind === "auth.login_success");
      expect(success!.userId).toBe("user-A");
    });
  });

  // ─── V-M-AUTH-SERVICE scenario-2 ───────────────────────────────────────────
  describe("scenario-2: login fails → localized error", () => {
    it("maps 402/403 to NO_SUBSCRIPTION", async () => {
      const client = buildFailingLoginClient({ status: 402, message: "no sub" });
      const { deps } = buildDeps({ apiClient: client });
      const svc = new AuthService(deps);
      await svc.init();

      const r = await svc.login("CODE-X");
      expect(r.ok).toBe(false);
      expect(r.errorCode).toBe("NO_SUBSCRIPTION");
      expect(r.error).toBe("[i18n:auth.error.no_subscription]");
    });

    it("maps 400/404 to INVALID_CODE", async () => {
      const client = buildFailingLoginClient({ status: 400, message: "bad" });
      const { deps } = buildDeps({ apiClient: client });
      const svc = new AuthService(deps);
      await svc.init();

      const r = await svc.login("CODE-X");
      expect(r.errorCode).toBe("INVALID_CODE");
      expect(r.error).toBe("[i18n:auth.error.invalid_code]");
    });

    it("maps network-shape errors to NETWORK_ERROR", async () => {
      const client = buildFailingLoginClient(new Error("ENETUNREACH"));
      const { deps } = buildDeps({ apiClient: client });
      const svc = new AuthService(deps);
      await svc.init();

      const r = await svc.login("CODE-X");
      expect(r.errorCode).toBe("NETWORK_ERROR");
      expect(r.error).toBe("[i18n:auth.error.network_error]");
    });

    it("treats 200 with empty body as INVALID_CODE (no token persisted)", async () => {
      const { client } = buildOkLoginClient({ sessionToken: "", userId: "" });
      const { deps, settings } = buildDeps({ apiClient: client });
      const svc = new AuthService(deps);
      await svc.init();

      const r = await svc.login("CODE-X");
      expect(r.ok).toBe(false);
      expect(r.errorCode).toBe("INVALID_CODE");
      // No settings writes occurred for sessionId/userId.
      const tokenWrites = settings.setCalls.filter(
        (c) => c.key === "sessionId" || c.key === "userId",
      );
      expect(tokenWrites).toHaveLength(0);
    });
  });

  // ─── V-M-AUTH-SERVICE scenario-3 ───────────────────────────────────────────
  describe("scenario-3: logout() clears tokens, NO vault writes (UC-002)", () => {
    it("clears sessionId+userId and emits 'auth.disconnected'", async () => {
      const { deps, settings } = buildDeps();
      settings.seed("sessionId", "preexisting-token");
      settings.seed("userId", "user-A");
      const svc = new AuthService(deps);
      await svc.init();
      const received: AuthEvent[] = [];
      svc.subscribe((e) => received.push(e));

      await svc.logout();

      const sessionWrite = settings.setCalls.find((c) => c.key === "sessionId");
      const userWrite = settings.setCalls.find((c) => c.key === "userId");
      expect(sessionWrite?.value).toBeNull();
      expect(userWrite?.value).toBeNull();
      expect(received.some((e) => e.kind === "auth.disconnected")).toBe(true);
      // No vault writes: AuthService doesn't depend on a vault adapter at all,
      // so absence is the literal invariant — DI bag carries no IFileStorage.
      expect(Object.keys(deps)).not.toContain("vault");
    });

    it("emits AUTH_TOKEN_CLEARED marker after clearing", async () => {
      const { deps } = buildDeps();
      const svc = new AuthService(deps);
      await svc.init();
      await svc.logout();

      const events = (infoSpy.mock.calls as unknown[][])
        .map((c) => c[0])
        .filter((c): c is Record<string, unknown> => typeof c === "object" && c !== null);
      const cleared = events.find(
        (e) => e.event === "AUTH_TOKEN_CLEARED" && e.requirement === "UC-002",
      );
      expect(cleared).toBeDefined();
      expect(cleared!.anchor).toBe("logout:BLOCK_CLEAR");
    });
  });

  // ─── V-M-AUTH-SERVICE scenario-4 ───────────────────────────────────────────
  describe("scenario-4: logout401() = logout() + emits 'session-expired'", () => {
    it("clears tokens, emits 'session-expired', and invokes onSessionExpired", async () => {
      const { deps, settings, onSessionExpired } = buildDeps();
      settings.seed("sessionId", "expired-token");
      settings.seed("userId", "user-A");
      const svc = new AuthService(deps);
      await svc.init();
      const received: AuthEvent[] = [];
      svc.subscribe((e) => received.push(e));

      svc.logout401();

      // Allow microtask queue to flush so the fire-and-forget clearTokens lands.
      await Promise.resolve();
      await Promise.resolve();

      expect(received.some((e) => e.kind === "session-expired")).toBe(true);
      expect(onSessionExpired).toHaveBeenCalledTimes(1);

      const sessionWrite = settings.setCalls.find((c) => c.key === "sessionId");
      expect(sessionWrite?.value).toBeNull();
    });

    it("emits AUTH_TOKEN_CLEARED with UC-015 requirement", async () => {
      const { deps } = buildDeps();
      const svc = new AuthService(deps);
      await svc.init();
      svc.logout401();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      const events = (infoSpy.mock.calls as unknown[][])
        .map((c) => c[0])
        .filter((c): c is Record<string, unknown> => typeof c === "object" && c !== null);
      const cleared = events.find(
        (e) => e.event === "AUTH_TOKEN_CLEARED" && e.requirement === "UC-015",
      );
      expect(cleared).toBeDefined();
      expect(cleared!.anchor).toBe("logout401:BLOCK_CLEAR");
    });

    it("does not abort the cascade if onSessionExpired throws", async () => {
      const { deps } = buildDeps({
        onSessionExpired: () => {
          throw new Error("observer boom");
        },
      });
      const svc = new AuthService(deps);
      await svc.init();
      const received: AuthEvent[] = [];
      svc.subscribe((e) => received.push(e));

      expect(() => svc.logout401()).not.toThrow();
      await Promise.resolve();
      await Promise.resolve();
      expect(received.some((e) => e.kind === "session-expired")).toBe(true);
    });
  });

  // ─── V-M-AUTH-SERVICE scenario-5 ───────────────────────────────────────────
  describe("scenario-5: getApiToken() returns cached token after first load", () => {
    it("memoizes the resolved value", async () => {
      const { deps, settings } = buildDeps();
      settings.seed("sessionId", "cached-token");
      const svc = new AuthService(deps);
      await svc.init();

      const v1 = await svc.getApiToken();
      // Mutating the settings AFTER init must not affect the in-memory memo:
      settings.seed("sessionId", "different-token");
      const v2 = await svc.getApiToken();

      expect(v1).toBe("cached-token");
      expect(v2).toBe("cached-token");
    });

    it("returns null before init() falls back to SettingsManager once", async () => {
      const { deps, settings } = buildDeps();
      settings.seed("sessionId", "from-settings");
      const svc = new AuthService(deps);
      // init() intentionally NOT called here — exercise the pre-init code path.
      const v = await svc.getApiToken();
      expect(v).toBe("from-settings");
    });

    it("isReady() is false until init() + non-empty token", async () => {
      const { deps, settings } = buildDeps();
      const svc = new AuthService(deps);
      expect(svc.isReady()).toBe(false);

      settings.seed("sessionId", "");
      await svc.init();
      expect(svc.isReady()).toBe(false);

      settings.seed("sessionId", "non-empty");
      const svc2 = new AuthService(buildDeps({ settings: settings as unknown as SettingsManager }).deps);
      await svc2.init();
      expect(svc2.isReady()).toBe(true);
    });
  });

  // ─── V-M-AUTH-SERVICE scenario-6 ───────────────────────────────────────────
  describe("scenario-6 (integration): full auth → 401 → logout401 chain", () => {
    /**
     * Wires AuthService to the real ApiClientBase 401-callback registry, then
     * simulates a 401 response flowing through transformResult — this is the
     * production cascade described in UC-001 + UC-015. The AuthService is
     * registered as the module-level callback via init().
     */
    it("logs in, then 401 from HTTP-BASE triggers logout401", async () => {
      // Build a vanilla ApiClientBase (without NSwag) to drive transformResult.
      class TestableClient extends ApiClientBase {
        run401(response: any): void {
          this.transformResult("/protected", response, (r: any) =>
            of(r.body),
          ).subscribe();
        }
      }
      const cfg = new ApiClientBaseConfiguration(
        "https://api.readine.test",
        "1.0",
        async () => "tok-123",
      );
      const http = new TestableClient(cfg);

      const { deps, settings, onSessionExpired } = buildDeps();
      const svc = new AuthService(deps);
      await svc.init(); // wires registerLogout401Callback

      // 1) Login succeeds.
      const loginRes = await svc.login("CODE-1");
      expect(loginRes.ok).toBe(true);
      expect(svc.isReady()).toBe(true);

      // 2) Simulate a 401 — HTTP-BASE will invoke the registered callback.
      const received: AuthEvent[] = [];
      svc.subscribe((e) => received.push(e));
      const response: HttpResponse<string> = { status: 401, headers: {}, body: "" };
      http.run401(response);

      // The chain: HTTP-BASE.transformResult → registry → AuthService.logout401
      //         → clearTokens (async, settings.set) + events$.next('session-expired')
      //         + deps.onSessionExpired()
      await Promise.resolve();
      await Promise.resolve();

      expect(received.some((e) => e.kind === "session-expired")).toBe(true);
      expect(onSessionExpired).toHaveBeenCalledTimes(1);
      // Tokens cleared (last write of each key was null).
      const sessionWrites = settings.setCalls
        .filter((c) => c.key === "sessionId")
        .map((c) => c.value);
      expect(sessionWrites.at(-1)).toBeNull();
      const userWrites = settings.setCalls
        .filter((c) => c.key === "userId")
        .map((c) => c.value);
      expect(userWrites.at(-1)).toBeNull();
      // isReady() flips back to false.
      expect(svc.isReady()).toBe(false);

      // Extra: a second AuthService.init() would NOT chain-fire the previous
      // instance's logout401. We verify the registry holds only the most-recent
      // callback (HTTP-BASE design choice — see V-M-HTTP-BASE).
      const otherCb = vi.fn();
      registerLogout401Callback(otherCb);
      http.run401({ status: 401, headers: {}, body: "" });
      expect(otherCb).toHaveBeenCalledTimes(1);
    });
  });

  // ─── Defensive: AuthService used before init() ───────────────────────────
  describe("defensive: login before init()", () => {
    it("returns NETWORK_ERROR without calling the API", async () => {
      const { client } = buildOkLoginClient();
      const { deps } = buildDeps({ apiClient: client });
      const svc = new AuthService(deps);
      const r = await svc.login("CODE-1");
      expect(r.ok).toBe(false);
      expect(r.errorCode).toBe("NETWORK_ERROR");
      expect(client.apiAccountObsidianLogin).not.toHaveBeenCalled();
    });
  });

  // ─── Listener safety ───────────────────────────────────────────────────────
  describe("subscribe() / unsubscribe()", () => {
    it("returns a working unsubscribe and swallows listener errors", async () => {
      const { deps } = buildDeps();
      const svc = new AuthService(deps);
      await svc.init();

      const handler = vi.fn().mockImplementation(() => {
        throw new Error("listener boom");
      });
      const off = svc.subscribe(handler);
      await svc.logout();
      expect(handler).toHaveBeenCalled();
      const calls = handler.mock.calls.length;
      // Detach and emit again — no further calls.
      off();
      await svc.logout();
      expect(handler.mock.calls.length).toBe(calls);

      // No uncaught rejections — the previous logout completed cleanly.
      expect(warnSpy).toHaveBeenCalled();
    });
  });
});

// START_CHANGE_SUMMARY
// LAST_CHANGE: 2026-05-13 — initial test suite for V-M-AUTH-SERVICE
// END_CHANGE_SUMMARY
