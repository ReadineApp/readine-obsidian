// START_MODULE_CONTRACT
// PURPOSE: Unit tests for M-NETWORK-DETECT — getConnection, onConnectionChange.
// SCOPE: src/network/network-detect.test.ts
// DEPENDS: M-NETWORK-DETECT
// LINKS: V-M-NETWORK-DETECT
// ROLE: TEST
// END_MODULE_CONTRACT

// START_MODULE_MAP
// (test file — no public exports)
// END_MODULE_MAP

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getConnection, onConnectionChange, __resetConnectionCache } from "./network-detect";

interface FakeConnection {
  type?: string;
  effectiveType?: string;
  listeners: Array<() => void>;
  addEventListener(event: "change", cb: () => void): void;
  removeEventListener(event: "change", cb: () => void): void;
  trigger(): void;
}

function makeFakeConnection(
  type: string | undefined,
  effectiveType?: string,
): FakeConnection {
  const listeners: Array<() => void> = [];
  return {
    type,
    effectiveType,
    listeners,
    addEventListener(_event, cb) {
      listeners.push(cb);
    },
    removeEventListener(_event, cb) {
      const idx = listeners.indexOf(cb);
      if (idx >= 0) listeners.splice(idx, 1);
    },
    trigger() {
      for (const l of listeners) l();
    },
  };
}

describe("M-NETWORK-DETECT (V-M-NETWORK-DETECT)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    __resetConnectionCache();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // scenario-1: getConnection returns 'wifi' when connection.type='wifi'
  it("scenario-1: returns 'wifi' when navigator.connection.type='wifi'", () => {
    vi.stubGlobal("navigator", {
      onLine: true,
      connection: makeFakeConnection("wifi", "4g"),
    });
    const c = getConnection();
    expect(c.type).toBe("wifi");
    expect(c.online).toBe(true);
    expect(c.effectiveType).toBe("4g");
  });

  // scenario-2: returns offline when navigator.onLine=false
  it("scenario-2: returns type='none' and online=false when offline", () => {
    vi.stubGlobal("navigator", {
      onLine: false,
      connection: makeFakeConnection("wifi"),
    });
    const c = getConnection();
    expect(c.type).toBe("none");
    expect(c.online).toBe(false);
  });

  // scenario-3: connection?.type undefined → fallback on effectiveType
  it("scenario-3: falls back to 'unknown' when connection.type is undefined but online", () => {
    vi.stubGlobal("navigator", {
      onLine: true,
      connection: makeFakeConnection(undefined, "4g"),
    });
    const c = getConnection();
    expect(c.type).toBe("unknown");
    expect(c.online).toBe(true);
    expect(c.effectiveType).toBe("4g");
  });

  it("classifies 4g/3g connection.type as 'cellular'", () => {
    vi.stubGlobal("navigator", {
      onLine: true,
      connection: makeFakeConnection("cellular", "4g"),
    });
    expect(getConnection().type).toBe("cellular");
  });

  it("returns unknown/offline when navigator is missing", () => {
    vi.stubGlobal("navigator", undefined);
    const c = getConnection();
    expect(c.type).toBe("unknown");
    expect(c.online).toBe(false);
  });

  it("emits NETWORK_STATE log marker", () => {
    vi.stubGlobal("navigator", {
      onLine: true,
      connection: makeFakeConnection("wifi"),
    });
    const spy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    getConnection();
    const payload = spy.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(payload).toBeDefined();
    expect(payload.module).toBe("M-NETWORK-DETECT");
    expect(payload.event).toBe("NETWORK_STATE");
    expect(payload.anchor).toBe("getConnection");
  });

  describe("onConnectionChange()", () => {
    it("invokes callback when connection 'change' fires", () => {
      const fake = makeFakeConnection("wifi");
      vi.stubGlobal("navigator", { onLine: true, connection: fake });
      const cb = vi.fn();
      const unsub = onConnectionChange(cb);
      fake.trigger();
      expect(cb).toHaveBeenCalledTimes(1);
      unsub();
      fake.trigger();
      expect(cb).toHaveBeenCalledTimes(1);
    });

    it("returns a no-op unsubscribe when connection API is unavailable", () => {
      vi.stubGlobal("navigator", { onLine: true });
      expect(() => onConnectionChange(() => {})()).not.toThrow();
    });
  });
});

// START_CHANGE_SUMMARY
// LAST_CHANGE: 2026-05-13 — initial test suite for V-M-NETWORK-DETECT
// END_CHANGE_SUMMARY
