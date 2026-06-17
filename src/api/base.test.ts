// START_MODULE_CONTRACT
// PURPOSE: Unit tests for M-HTTP-BASE — ApiClientBase transformOptions/transformResult, requestUrlAdapter, registerLogout401Callback.
// SCOPE: src/api/base.test.ts
// DEPENDS: M-HTTP-BASE
// LINKS: V-M-HTTP-BASE
// ROLE: TEST
// END_MODULE_CONTRACT

// START_MODULE_MAP
// (test file — no public exports)
// END_MODULE_MAP

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { firstValueFrom, of } from "rxjs";

vi.mock("obsidian", () => import("../__mocks__/obsidian"));

import {
  __resetObsidianMock,
  __setRequestUrlImpl,
  requestUrl,
} from "../__mocks__/obsidian";
import {
  __resetLogout401CallbackForTests,
  API_VERSION_HEADER,
  AUTH_ID_HEADER,
  ApiClientBase,
  ApiClientBaseConfiguration,
  registerLogout401Callback,
  requestUrlAdapter,
} from "./base";
import type { HttpOptions, HttpResponse } from "./base";

class TestableClient extends ApiClientBase {
  callTransformOptions(options: HttpOptions): Promise<HttpOptions> {
    return this.transformOptions(options);
  }
  callTransformResult<T, R>(
    url: string,
    response: any,
    processor: (r: any) => import("rxjs").Observable<R>,
  ) {
    return this.transformResult(url, response, processor);
  }
}

const FIXED_TOKEN = "token-xyz";
const FIXED_VERSION = "1.0";
const FIXED_BASE = "https://api.readine.test";

function makeConfig(opts: {
  token?: string | null;
  onLogout401?: () => void;
} = {}): ApiClientBaseConfiguration {
  return new ApiClientBaseConfiguration(
    FIXED_BASE,
    FIXED_VERSION,
    async () => (opts.token === undefined ? FIXED_TOKEN : opts.token),
    opts.onLogout401,
  );
}

describe("M-HTTP-BASE (V-M-HTTP-BASE)", () => {
  beforeEach(() => {
    __resetObsidianMock();
    __resetLogout401CallbackForTests();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // V-M-HTTP-BASE scenario-1: transformOptions adds AuthId + api-version
  describe("transformOptions()", () => {
    it("scenario-1: adds AuthId + api-version headers and mutates the options bag", async () => {
      const client = new TestableClient(makeConfig());
      const options: HttpOptions = { method: "GET" };
      const out = await client.callTransformOptions(options);
      expect(out.headers).toBeDefined();
      expect(out.headers![API_VERSION_HEADER]).toBe(FIXED_VERSION);
      expect(out.headers![AUTH_ID_HEADER]).toBe(FIXED_TOKEN);
      // NSwag-generated callers expect transformOptions to mutate-in-place.
      expect(options.headers).toBe(out.headers);
    });

    it("preserves pre-existing headers when injecting auth", async () => {
      const client = new TestableClient(makeConfig());
      const options: HttpOptions = {
        method: "GET",
        headers: { "x-correlation-id": "abc" },
      };
      const out = await client.callTransformOptions(options);
      expect(out.headers!["x-correlation-id"]).toBe("abc");
      expect(out.headers![AUTH_ID_HEADER]).toBe(FIXED_TOKEN);
      expect(out.headers![API_VERSION_HEADER]).toBe(FIXED_VERSION);
    });

    it("omits AuthId header when token is null or empty", async () => {
      const clientNull = new TestableClient(makeConfig({ token: null }));
      const out1 = await clientNull.callTransformOptions({});
      expect(out1.headers![API_VERSION_HEADER]).toBe(FIXED_VERSION);
      expect(out1.headers![AUTH_ID_HEADER]).toBeUndefined();

      const clientEmpty = new TestableClient(makeConfig({ token: "" }));
      const out2 = await clientEmpty.callTransformOptions({});
      expect(out2.headers![AUTH_ID_HEADER]).toBeUndefined();
    });

    it("emits HEADERS_INJECTED log marker", async () => {
      const spy = vi.spyOn(console, 'debug').mockImplementation(() => {});
      const client = new TestableClient(makeConfig());
      await client.callTransformOptions({});
      const payloads = spy.mock.calls
        .map((c) => c[0])
        .filter((c): c is Record<string, unknown> => typeof c === "object" && c !== null);
      const headersEvent = payloads.find(
        (p) => p.event === "HEADERS_INJECTED" && p.module === "M-HTTP-BASE",
      );
      expect(headersEvent).toBeDefined();
      expect(headersEvent!.anchor).toBe(
        "transformOptions:BLOCK_INJECT_HEADERS",
      );
    });
  });

  // V-M-HTTP-BASE scenario-2: transformResult passes 200 through
  describe("transformResult()", () => {
    it("scenario-2: passes a 200 response through the processor", async () => {
      const client = new TestableClient(makeConfig());
      const response: HttpResponse<string> = {
        status: 200,
        headers: {},
        body: "ok",
      };
      const result$ = client.callTransformResult(
        "/some-url",
        response,
        (r) => of(r.body.toUpperCase()),
      );
      const value = await firstValueFrom(result$);
      expect(value).toBe("OK");
    });

    // V-M-HTTP-BASE scenario-3: transformResult catches 401 → triggers logout callback
    it("scenario-3: triggers per-instance onLogout401 callback on 401", () => {
      const logout = vi.fn();
      const client = new TestableClient(makeConfig({ onLogout401: logout }));
      const response: HttpResponse<string> = {
        status: 401,
        headers: {},
        body: "",
      };
      // NSwag invokes transformResult twice (once in mergeMap, once in catch).
      // The 2nd call MUST NOT re-fire the logout (idempotence guarantee).
      client.callTransformResult("/protected", response, (r) => of(r.body));
      client.callTransformResult("/protected", response, (r) => of(r.body));
      expect(logout).toHaveBeenCalledTimes(1);
    });

    it("falls back to the module-level registry when no per-instance callback is set", () => {
      const logout = vi.fn();
      registerLogout401Callback(logout);
      const client = new TestableClient(makeConfig()); // no onLogout401
      const response: HttpResponse<string> = {
        status: 401,
        headers: {},
        body: "",
      };
      client.callTransformResult("/protected", response, (r) => of(r.body));
      expect(logout).toHaveBeenCalledTimes(1);
    });

    it("does NOT invoke logout on non-401 responses (e.g. 500)", () => {
      const logout = vi.fn();
      const client = new TestableClient(makeConfig({ onLogout401: logout }));
      const response: HttpResponse<string> = {
        status: 500,
        headers: {},
        body: "boom",
      };
      client.callTransformResult("/x", response, (r) => of(r.body));
      expect(logout).not.toHaveBeenCalled();
    });

    it("emits AUTH_401_DETECTED log marker on 401", () => {
      const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const client = new TestableClient(
        makeConfig({ onLogout401: () => {} }),
      );
      const response: HttpResponse<string> = {
        status: 401,
        headers: {},
        body: "",
      };
      client.callTransformResult("/protected", response, (r) => of(r.body));
      const payload = spy.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(payload).toBeDefined();
      expect(payload.module).toBe("M-HTTP-BASE");
      expect(payload.event).toBe("AUTH_401_DETECTED");
      expect(payload.anchor).toBe("transformResult:BLOCK_CHECK_401");
    });
  });

  // V-M-HTTP-BASE scenario-4: full call with mocked requestUrl returns Observable
  describe("requestUrlAdapter() — integration", () => {
    it("scenario-4: returns an Observable that emits the mapped HttpResponse", async () => {
      __setRequestUrlImpl(async () => ({
        status: 200,
        headers: { "content-type": "application/json" },
        arrayBuffer: new ArrayBuffer(0),
        text: '{"hello":"world"}',
        json: { hello: "world" },
      }));
      const envelope = await firstValueFrom(
        requestUrlAdapter("https://api.readine.test/feed", {
          method: "GET",
          headers: { [AUTH_ID_HEADER]: FIXED_TOKEN },
        }),
      );
      expect(envelope.status).toBe(200);
      expect(envelope.headers["content-type"]).toBe("application/json");
      expect(envelope.body).toBe('{"hello":"world"}');
      expect(envelope.text).toBe('{"hello":"world"}');
      // Verify underlying obsidian.requestUrl was invoked with throw=false
      // (we want to handle non-200 statuses ourselves).
      const lastCall = requestUrl.mock.calls.at(-1);
      expect(lastCall).toBeDefined();
      const param = lastCall![0] as unknown as Record<string, unknown>;
      expect(param.url).toBe("https://api.readine.test/feed");
      expect(param.method).toBe("GET");
      expect(param.throw).toBe(false);
      expect((param.headers as Record<string, string>)[AUTH_ID_HEADER]).toBe(
        FIXED_TOKEN,
      );
    });

    // V-M-HTTP-BASE scenario-5: full call with 401 → onLogout401 invoked exactly once
    it("scenario-5: full transformOptions → adapter → transformResult chain with 401 invokes logout exactly once", async () => {
      const logout = vi.fn();
      __setRequestUrlImpl(async () => ({
        status: 401,
        headers: {},
        arrayBuffer: new ArrayBuffer(0),
        text: "",
        json: null,
      }));
      const client = new TestableClient(makeConfig({ onLogout401: logout }));
      const opts = await client.callTransformOptions({ method: "GET" });
      const envelope = await firstValueFrom(
        requestUrlAdapter("https://api.readine.test/protected", opts),
      );
      // Verify headers landed on the actual request.
      const lastCall = requestUrl.mock.calls.at(-1);
      const param = lastCall![0] as unknown as Record<string, unknown>;
      const headers = param.headers as Record<string, string>;
      expect(headers[AUTH_ID_HEADER]).toBe(FIXED_TOKEN);
      expect(headers[API_VERSION_HEADER]).toBe(FIXED_VERSION);

      // Run through transformResult twice (NSwag double-invocation pattern).
      client.callTransformResult(
        "/protected",
        envelope,
        (r) => of(r.body),
      );
      client.callTransformResult(
        "/protected",
        envelope,
        (r) => of(r.body),
      );
      expect(logout).toHaveBeenCalledTimes(1);
    });

    it("propagates server errors as Observable errors when requestUrl rejects", async () => {
      __setRequestUrlImpl(async () => {
        throw new Error("ENETUNREACH");
      });
      await expect(
        firstValueFrom(
          requestUrlAdapter("https://api.readine.test/x", { method: "GET" }),
        ),
      ).rejects.toThrow("ENETUNREACH");
    });
  });

  describe("registerLogout401Callback() — callback inversion", () => {
    it("overwrites a previously registered callback", () => {
      const a = vi.fn();
      const b = vi.fn();
      registerLogout401Callback(a);
      registerLogout401Callback(b);
      const client = new TestableClient(makeConfig());
      client.callTransformResult(
        "/protected",
        { status: 401, headers: {}, body: "" },
        (r) => of(r.body),
      );
      expect(a).not.toHaveBeenCalled();
      expect(b).toHaveBeenCalledTimes(1);
    });
  });
});

// START_CHANGE_SUMMARY
// LAST_CHANGE: 2026-05-13 — initial test suite for V-M-HTTP-BASE
// END_CHANGE_SUMMARY
