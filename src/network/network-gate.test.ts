// START_MODULE_CONTRACT
// PURPOSE: Unit tests for M-NETWORK-GATE — isAllowed across the 4 settings × current connection state matrix. Pure function: no fake timers, no mocks beyond a console spy for the marker check.
// SCOPE: src/network/network-gate.test.ts
// DEPENDS: M-NETWORK-GATE, M-NETWORK-DETECT
// LINKS: V-M-NETWORK-GATE
// ROLE: TEST
// END_MODULE_CONTRACT

// START_MODULE_MAP
// (test file — no public exports)
// END_MODULE_MAP

import { describe, expect, it, vi } from "vitest";
import { isAllowed, type NetworkSetting } from "./network-gate";
import type { Connection } from "./network-detect";

function conn(
  type: Connection["type"],
  online: boolean,
  effectiveType?: string,
): Connection {
  const c: Connection = { type, online };
  if (effectiveType) c.effectiveType = effectiveType;
  return c;
}

describe("M-NETWORK-GATE (V-M-NETWORK-GATE)", () => {
  // scenario-1: off → false (regardless of connection state)
  it("scenario-1: setting='off' returns false even when online on Wi-Fi", () => {
    expect(isAllowed("off", conn("wifi", true, "4g"))).toBe(false);
    expect(isAllowed("off", conn("cellular", true))).toBe(false);
    expect(isAllowed("off", conn("none", false))).toBe(false);
  });

  // scenario-2: always → true (policy accepts any network)
  it("scenario-2: setting='always' returns true regardless of connection.type", () => {
    expect(isAllowed("always", conn("wifi", true))).toBe(true);
    expect(isAllowed("always", conn("cellular", true))).toBe(true);
    // 'always' ignores online — callers that need the offline guard use
    // connection.online directly. This documents the contract.
    expect(isAllowed("always", conn("unknown", true))).toBe(true);
  });

  // scenario-3: Wi-Fi-only + type=wifi + online → true
  it("scenario-3: Wi-Fi-only && type=wifi && online → true", () => {
    expect(isAllowed("Wi-Fi-only", conn("wifi", true))).toBe(true);
  });

  // scenario-4: Wi-Fi-only + type=cellular → false
  it("scenario-4: Wi-Fi-only && type=cellular → false", () => {
    expect(isAllowed("Wi-Fi-only", conn("cellular", true))).toBe(false);
  });

  // scenario-5: Wi-Fi+cellular && offline → false
  it("scenario-5: Wi-Fi+cellular && offline → false", () => {
    expect(isAllowed("Wi-Fi+cellular", conn("none", false))).toBe(false);
    expect(isAllowed("Wi-Fi+cellular", conn("wifi", false))).toBe(false);
  });

  it("Wi-Fi+cellular: wifi online → true", () => {
    expect(isAllowed("Wi-Fi+cellular", conn("wifi", true))).toBe(true);
  });

  it("Wi-Fi+cellular: cellular online → true", () => {
    expect(isAllowed("Wi-Fi+cellular", conn("cellular", true))).toBe(true);
  });

  it("Wi-Fi+cellular: 'unknown' type online → false (conservative — metered data risk)", () => {
    // Documented decision: when the navigator.connection API returns 'unknown'
    // we do not assume cellular is safe. Mobile-app users on flaky connection
    // detection benefit from the conservative default; desktop users typically
    // pick 'always'.
    expect(isAllowed("Wi-Fi+cellular", conn("unknown", true))).toBe(false);
  });

  it("Wi-Fi-only: offline wifi → false (online guard supersedes type)", () => {
    expect(isAllowed("Wi-Fi-only", conn("wifi", false))).toBe(false);
  });

  it("emits NETWORK_GATE_DECISION log marker with anchor 'isAllowed:BLOCK_DECIDE'", () => {
    const spy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    isAllowed("always", conn("wifi", true));
    const payload = spy.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(payload).toBeDefined();
    expect(payload.module).toBe("M-NETWORK-GATE");
    expect(payload.event).toBe("NETWORK_GATE_DECISION");
    expect(payload.anchor).toBe("isAllowed:BLOCK_DECIDE");
    expect(payload.allowed).toBe(true);
    spy.mockRestore();
  });

  it("throws on unknown setting (exhaustiveness guard)", () => {
    expect(() =>
      isAllowed("invalid" as NetworkSetting, conn("wifi", true)),
    ).toThrow(/UNKNOWN_NETWORK_SETTING/);
  });
});

// START_CHANGE_SUMMARY
// LAST_CHANGE: 2026-05-13 — initial test suite for V-M-NETWORK-GATE
// END_CHANGE_SUMMARY
