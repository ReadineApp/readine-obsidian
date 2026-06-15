// START_MODULE_CONTRACT
// PURPOSE: Fixed-capacity in-memory ring buffer (last 200 log lines) for support-bundle / error mirroring.
// SCOPE: src/logs/log-ring-buffer.ts
// DEPENDS: none
// LINKS: UC-018, UC-019, V-M-LOG-RING-BUFFER
// ROLE: RUNTIME
// END_MODULE_CONTRACT

// START_MODULE_MAP
// LogLine - structural type of a single log entry stored in the buffer
// LogRingBuffer - class with addLine(line) and getSnapshot()
// DEFAULT_CAPACITY - exported constant; default ring size (200)
// END_MODULE_MAP

// START_BLOCK_TYPES
/**
 * Shape of a single line stored in the ring. Loose typing on purpose: the buffer
 * does not own the schema — callers (M-ERROR-HANDLER, M-SUPPORT-BUNDLE) decide.
 */
export interface LogLine {
  ts: string;
  level: "debug" | "info" | "warn" | "error";
  anchor?: string;
  module?: string;
  requirement?: string;
  event: string;
  belief?: string;
  message?: string;
  [extra: string]: unknown;
}
// END_BLOCK_TYPES

export const DEFAULT_CAPACITY = 200;

// START_BLOCK_RING_CLASS
/**
 * START_CONTRACT: LogRingBuffer.addLine
 * PURPOSE: append a log line; oldest entry is overwritten once capacity is reached
 * INPUTS: line: LogLine
 * OUTPUTS: void
 * SIDE_EFFECTS: mutates internal slot array
 * LINKS: UC-019, V-M-LOG-RING-BUFFER
 * END_CONTRACT: LogRingBuffer.addLine
 *
 * START_CONTRACT: LogRingBuffer.getSnapshot
 * PURPOSE: return a chronologically-ordered copy of the buffer contents
 * INPUTS: none
 * OUTPUTS: LogLine[] — oldest first, newest last
 * SIDE_EFFECTS: none
 * LINKS: UC-019, V-M-LOG-RING-BUFFER
 * END_CONTRACT: LogRingBuffer.getSnapshot
 */
export class LogRingBuffer {
  private readonly capacity: number;
  private readonly slots: (LogLine | undefined)[];
  private writeIndex = 0;
  private filled = 0;

  constructor(capacity: number = DEFAULT_CAPACITY) {
    if (!Number.isFinite(capacity) || capacity <= 0) {
      throw new Error("LogRingBuffer: capacity must be a positive integer");
    }
    this.capacity = Math.floor(capacity);
    this.slots = new Array<LogLine | undefined>(this.capacity);
  }

  addLine(line: LogLine): void {
    this.slots[this.writeIndex] = line;
    this.writeIndex = (this.writeIndex + 1) % this.capacity;
    if (this.filled < this.capacity) {
      this.filled += 1;
    }
  }

  getSnapshot(): LogLine[] {
    const out: LogLine[] = [];
    if (this.filled < this.capacity) {
      // Buffer not yet wrapped — entries occupy indices [0, writeIndex).
      for (let i = 0; i < this.filled; i += 1) {
        const entry = this.slots[i];
        if (entry !== undefined) {
          out.push(entry);
        }
      }
      return out;
    }
    // Buffer wrapped — oldest entry sits at writeIndex.
    for (let i = 0; i < this.capacity; i += 1) {
      const idx = (this.writeIndex + i) % this.capacity;
      const entry = this.slots[idx];
      if (entry !== undefined) {
        out.push(entry);
      }
    }
    return out;
  }

  /** Current number of lines retained (≤ capacity). */
  size(): number {
    return this.filled;
  }
}
// END_BLOCK_RING_CLASS

// START_CHANGE_SUMMARY
// LAST_CHANGE: 2026-05-13 — initial implementation per Phase 1
// END_CHANGE_SUMMARY
