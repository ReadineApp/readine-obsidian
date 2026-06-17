// START_MODULE_CONTRACT
// PURPOSE: Unit tests for M-HTTP-HELPER — withRetry.
// SCOPE: src/api/api-helper.test.ts
// DEPENDS: M-HTTP-HELPER
// LINKS: V-M-HTTP-HELPER
// ROLE: TEST
// END_MODULE_CONTRACT

// START_MODULE_MAP
// (test file — no public exports)
// END_MODULE_MAP

import { describe, expect, it, vi } from "vitest";
import { defer, of, throwError } from "rxjs";
import { firstValueFrom } from "rxjs";
import { DEFAULT_SKIP_STATUSES, withRetry } from "./api-helper";

describe("M-HTTP-HELPER (V-M-HTTP-HELPER)", () => {
  // V-M-HTTP-HELPER scenario-1: withRetry succeeds first attempt
  it("scenario-1: passes through values on first success", async () => {
    const src$ = of("ok");
    const result = await firstValueFrom(withRetry(src$, 3, 1));
    expect(result).toBe("ok");
  });

  // V-M-HTTP-HELPER scenario-2: withRetry retries 3× then gives up
  it("scenario-2: retries N times then gives up", async () => {
    let attempts = 0;
    const src$ = defer(() => {
      attempts += 1;
      return throwError(() => ({ status: 500, message: "boom" }));
    });
    await expect(firstValueFrom(withRetry(src$, 3, 0))).rejects.toMatchObject({
      status: 500,
    });
    // 1 original attempt + 3 retries = 4 total subscriptions.
    expect(attempts).toBe(4);
  });

  it("succeeds on the 2nd attempt after a transient failure", async () => {
    let attempts = 0;
    const src$ = defer(() => {
      attempts += 1;
      if (attempts === 1) {
        return throwError(() => ({ status: 503 }));
      }
      return of("recovered");
    });
    const result = await firstValueFrom(withRetry(src$, 3, 0));
    expect(result).toBe("recovered");
    expect(attempts).toBe(2);
  });

  // V-M-HTTP-HELPER scenario-3: withRetry skips 401 (configurable skipStatuses)
  it("scenario-3: propagates 401 immediately without retrying (default skipStatuses=[401])", async () => {
    let attempts = 0;
    const src$ = defer(() => {
      attempts += 1;
      return throwError(() => ({ status: 401, message: "unauthorized" }));
    });
    await expect(firstValueFrom(withRetry(src$, 5, 0))).rejects.toMatchObject({
      status: 401,
    });
    expect(attempts).toBe(1);
  });

  it("respects a custom skipStatuses list", async () => {
    let attempts = 0;
    const src$ = defer(() => {
      attempts += 1;
      return throwError(() => ({ status: 403 }));
    });
    await expect(
      firstValueFrom(withRetry(src$, 5, 0, [403])),
    ).rejects.toMatchObject({ status: 403 });
    expect(attempts).toBe(1);
  });

  it("retries non-HTTP errors (no status field) too", async () => {
    let attempts = 0;
    const src$ = defer(() => {
      attempts += 1;
      if (attempts < 3) {
        return throwError(() => new Error("network glitch"));
      }
      return of("late ok");
    });
    const result = await firstValueFrom(withRetry(src$, 3, 0));
    expect(result).toBe("late ok");
    expect(attempts).toBe(3);
  });

  it("waits delayMs between retries (fake timers)", async () => {
    vi.useFakeTimers();
    let attempts = 0;
    const src$ = defer(() => {
      attempts += 1;
      if (attempts < 2) {
        return throwError(() => ({ status: 500 }));
      }
      return of("after-delay");
    });
    const promise = firstValueFrom(withRetry(src$, 3, 1000));
    // Drain pending microtasks for first subscription/error.
    await vi.advanceTimersByTimeAsync(0);
    expect(attempts).toBe(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await promise).toBe("after-delay");
    vi.useRealTimers();
  });

  it("rejects invalid retries / delayMs arguments", () => {
    expect(() => withRetry(of(1), -1, 0)).toThrow();
    expect(() => withRetry(of(1), 0, -5)).toThrow();
    expect(() => withRetry(of(1), Number.NaN, 0)).toThrow();
  });

  it("exposes DEFAULT_SKIP_STATUSES as [401]", () => {
    expect(DEFAULT_SKIP_STATUSES).toEqual([401]);
  });
});

// START_CHANGE_SUMMARY
// LAST_CHANGE: 2026-05-13 — initial test suite for V-M-HTTP-HELPER
// END_CHANGE_SUMMARY
