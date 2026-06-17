// START_MODULE_CONTRACT
// PURPOSE: Unit tests for M-LOG-RING-BUFFER — append, wrap-around, chronological snapshot.
// SCOPE: src/logs/log-ring-buffer.test.ts
// DEPENDS: M-LOG-RING-BUFFER
// LINKS: V-M-LOG-RING-BUFFER
// ROLE: TEST
// END_MODULE_CONTRACT

// START_MODULE_MAP
// (test file — no public exports)
// END_MODULE_MAP

import { describe, expect, it } from "vitest";
import { DEFAULT_CAPACITY, LogLine, LogRingBuffer } from "./log-ring-buffer";

function makeLine(event: string, ts: string = "2026-05-13T00:00:00.000Z"): LogLine {
  return { ts, level: "info", event };
}

describe("M-LOG-RING-BUFFER (V-M-LOG-RING-BUFFER)", () => {
  it("scenario-1: addLine appends within capacity", () => {
    const buf = new LogRingBuffer(5);
    buf.addLine(makeLine("a"));
    buf.addLine(makeLine("b"));
    buf.addLine(makeLine("c"));
    const snap = buf.getSnapshot();
    expect(snap.map((l) => l.event)).toEqual(["a", "b", "c"]);
    expect(buf.size()).toBe(3);
  });

  it("scenario-2: addLine wraps around at the configured capacity", () => {
    const cap = 4;
    const buf = new LogRingBuffer(cap);
    for (let i = 0; i < cap + 3; i += 1) {
      buf.addLine(makeLine(`evt-${i}`));
    }
    const snap = buf.getSnapshot();
    expect(snap).toHaveLength(cap);
    // Oldest evt-0..evt-2 dropped; remaining = evt-3..evt-6 (chronological).
    expect(snap.map((l) => l.event)).toEqual([
      "evt-3",
      "evt-4",
      "evt-5",
      "evt-6",
    ]);
  });

  it("scenario-3: getSnapshot returns entries in chronological order", () => {
    const buf = new LogRingBuffer(3);
    const lines = [
      makeLine("one", "2026-05-13T00:00:01.000Z"),
      makeLine("two", "2026-05-13T00:00:02.000Z"),
      makeLine("three", "2026-05-13T00:00:03.000Z"),
    ];
    for (const l of lines) buf.addLine(l);
    const snap = buf.getSnapshot();
    expect(snap.map((l) => l.ts)).toEqual([
      "2026-05-13T00:00:01.000Z",
      "2026-05-13T00:00:02.000Z",
      "2026-05-13T00:00:03.000Z",
    ]);
  });

  it("defaults to a capacity of 200 lines", () => {
    expect(DEFAULT_CAPACITY).toBe(200);
    const buf = new LogRingBuffer();
    for (let i = 0; i < 250; i += 1) {
      buf.addLine(makeLine(`x-${i}`));
    }
    expect(buf.getSnapshot()).toHaveLength(200);
  });

  it("rejects non-positive capacity", () => {
    expect(() => new LogRingBuffer(0)).toThrow();
    expect(() => new LogRingBuffer(-1)).toThrow();
  });

  it("returns a copy (mutation does not affect later snapshots)", () => {
    const buf = new LogRingBuffer(3);
    buf.addLine(makeLine("a"));
    const snap = buf.getSnapshot();
    snap.pop();
    expect(buf.getSnapshot()).toHaveLength(1);
  });
});

// START_CHANGE_SUMMARY
// LAST_CHANGE: 2026-05-13 — initial test suite for V-M-LOG-RING-BUFFER
// END_CHANGE_SUMMARY
