// START_MODULE_CONTRACT
// PURPOSE: Unit tests for M-HTTP-LOGS-BASE — ApiClientLogsBase: transformOptions adds api-version only; transformResult never triggers logout on 401.
// SCOPE: src/api/base-logs.test.ts
// DEPENDS: M-HTTP-LOGS-BASE
// LINKS: V-M-HTTP-LOGS-BASE
// ROLE: TEST
// END_MODULE_CONTRACT

// START_MODULE_MAP
// (test file — no public exports)
// END_MODULE_MAP

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { firstValueFrom, of } from "rxjs";

vi.mock("obsidian", () => import("../__mocks__/obsidian"));

import { __resetObsidianMock } from "../__mocks__/obsidian";
import {
  API_VERSION_HEADER,
  AUTH_ID_HEADER,
  __resetLogout401CallbackForTests,
  registerLogout401Callback,
} from "./base";
import type { HttpOptions, HttpResponse } from "./base";
import {
  ApiClientLogsBase,
  ApiClientLogsBaseConfiguration,
} from "./base-logs";

class TestableLogsClient extends ApiClientLogsBase {
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

const FIXED_VERSION = "1.0";
const FIXED_BASE = "https://logs.readine.test";

describe("M-HTTP-LOGS-BASE (V-M-HTTP-LOGS-BASE)", () => {
  beforeEach(() => {
    __resetObsidianMock();
    __resetLogout401CallbackForTests();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // V-M-HTTP-LOGS-BASE scenario-1: transformOptions adds api-version but NOT AuthId
  it("scenario-1: adds api-version header but never adds AuthId", async () => {
    const client = new TestableLogsClient(
      new ApiClientLogsBaseConfiguration(FIXED_BASE, FIXED_VERSION),
    );
    const options: HttpOptions = { method: "POST", body: "payload" };
    const out = await client.callTransformOptions(options);
    expect(out.headers).toBeDefined();
    expect(out.headers![API_VERSION_HEADER]).toBe(FIXED_VERSION);
    expect(out.headers![AUTH_ID_HEADER]).toBeUndefined();
    // Mutation-in-place semantics, mirroring NSwag's expectation.
    expect(options.headers).toBe(out.headers);
  });

  it("preserves pre-existing headers when injecting api-version", async () => {
    const client = new TestableLogsClient(
      new ApiClientLogsBaseConfiguration(FIXED_BASE, FIXED_VERSION),
    );
    const out = await client.callTransformOptions({
      headers: { "content-type": "application/json" },
    });
    expect(out.headers!["content-type"]).toBe("application/json");
    expect(out.headers![API_VERSION_HEADER]).toBe(FIXED_VERSION);
    expect(out.headers![AUTH_ID_HEADER]).toBeUndefined();
  });

  // V-M-HTTP-LOGS-BASE scenario-2: transformResult does NOT trigger logout on 401
  it("scenario-2: NEVER triggers the global logout callback on 401 (channel must work with broken session)", async () => {
    const logout = vi.fn();
    // Even when AuthService has registered its callback, the logs channel must
    // ignore 401s — otherwise a logs upload during/after session expiry would
    // loop the logout cascade.
    registerLogout401Callback(logout);
    const client = new TestableLogsClient(
      new ApiClientLogsBaseConfiguration(FIXED_BASE, FIXED_VERSION),
    );
    const response: HttpResponse<string> = {
      status: 401,
      headers: {},
      body: "",
    };
    const out = await firstValueFrom(
      client.callTransformResult("/api/l/s", response, (r) =>
        of(r.body),
      ),
    );
    expect(out).toBe("");
    expect(logout).not.toHaveBeenCalled();
  });

  it("passes non-401 responses through the processor unchanged", async () => {
    const client = new TestableLogsClient(
      new ApiClientLogsBaseConfiguration(FIXED_BASE, FIXED_VERSION),
    );
    const response: HttpResponse<string> = {
      status: 200,
      headers: {},
      body: "ack",
    };
    const out = await firstValueFrom(
      client.callTransformResult("/api/l/s", response, (r) =>
        of(r.body.toUpperCase()),
      ),
    );
    expect(out).toBe("ACK");
  });
});

// START_CHANGE_SUMMARY
// LAST_CHANGE: 2026-05-13 — initial test suite for V-M-HTTP-LOGS-BASE
// END_CHANGE_SUMMARY
