// START_MODULE_CONTRACT
// PURPOSE: Unit tests for M-ERROR-HANDLER — capture branches (console.error / window.error / unhandledrejection), noise filter, ring-buffer mirror, register/unregister lifecycle.
// SCOPE: src/logs/error-handler.test.ts
// DEPENDS: M-ERROR-HANDLER, M-LOG-RING-BUFFER
// LINKS: V-M-ERROR-HANDLER
// ROLE: TEST
// END_MODULE_CONTRACT

// START_MODULE_MAP
// (test file — no public exports)
// END_MODULE_MAP

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { firstValueFrom, take, toArray } from "rxjs";

vi.mock("obsidian", () => import("../__mocks__/obsidian"));

import { LogRingBuffer } from "./log-ring-buffer";
import {
  ErrorHandler,
  NOISE_PATTERNS,
  type ErrorMsgForSend,
  type PlatformLike,
} from "./error-handler";

// START_BLOCK_FIXTURES
function buildPlatformStub(ua = "test-agent/1.0"): PlatformLike {
  return { getPlatformLabel: () => ua };
}

/**
 * Controllable in-memory event bus. Mirrors the addEventListener / removeEventListener
 * subset that ErrorHandler.register() touches. Tests call dispatch(type, payload)
 * to synthesise window-level events without needing JSDOM.
 */
class FakeEventBus {
  private listeners = new Map<string, Array<(ev: Event) => void>>();

  addEventListener(
    type: string,
    listener: (ev: Event) => void,
    _opts?: boolean | { capture?: boolean },
  ): void {
    let bucket = this.listeners.get(type);
    if (!bucket) {
      bucket = [];
      this.listeners.set(type, bucket);
    }
    bucket.push(listener);
  }

  removeEventListener(
    type: string,
    listener: (ev: Event) => void,
    _opts?: boolean | { capture?: boolean },
  ): void {
    const bucket = this.listeners.get(type);
    if (!bucket) return;
    const idx = bucket.indexOf(listener);
    if (idx >= 0) bucket.splice(idx, 1);
  }

  dispatch(type: string, payload: unknown): void {
    const bucket = this.listeners.get(type);
    if (!bucket) return;
    for (const listener of bucket.slice()) {
      // Tests synthesise structurally-shaped payloads — the handler reads ev.message etc.
      listener(payload as Event);
    }
  }

  listenerCount(type: string): number {
    return this.listeners.get(type)?.length ?? 0;
  }
}

function buildHandler() {
  const buffer = new LogRingBuffer(50);
  const platform = buildPlatformStub();
  const bus = new FakeEventBus();
  const handler = new ErrorHandler({
    ringBuffer: buffer,
    platform,
    globalBus: bus,
  });
  return { buffer, handler, bus };
}

/**
 * Synthesise an ErrorEvent-shaped object. We do not need a real `ErrorEvent`
 * constructor — the handler reads ev.message / ev.filename / ev.lineno /
 * ev.colno / ev.error structurally.
 */
function makeErrorEvent(init: {
  message?: string;
  filename?: string;
  lineno?: number;
  colno?: number;
  error?: Error;
}): unknown {
  return { ...init };
}

function makeRejectionEvent(reason: unknown): unknown {
  return { reason };
}
// END_BLOCK_FIXTURES

describe("M-ERROR-HANDLER (V-M-ERROR-HANDLER)", () => {
  let originalConsoleError: typeof console.error;
  let infoSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // Snapshot console.error so test teardown can restore even when register()
    // is left dangling by a failing assertion.
    originalConsoleError = console.error;
    infoSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
  });

  afterEach(() => {
    // Defensive restore — register() patches console.error globally.
    // eslint-disable-next-line no-console
    console.error = originalConsoleError;
    vi.restoreAllMocks();
  });

  // ─── V-M-ERROR-HANDLER scenario-1 ──────────────────────────────────────────
  describe("scenario-1: console.error → emits ErrorMsgForSend", () => {
    it("captures the first call as src='c'", async () => {
      const { handler } = buildHandler();
      handler.register();
      try {
        const first$ = firstValueFrom(handler.getMessagesStream().pipe(take(1)));
        // Trigger the wrapped console.error.
        // eslint-disable-next-line no-console
        console.error("boom from console", { detail: "x" });
        const msg = await first$;
        expect(msg.src).toBe("c");
        expect(msg.thread).toBe("main");
        expect(msg.message).toBe("boom from console");
        expect(msg.details.k0).toBe("boom from console");
        expect(msg.details.k1).toContain("detail");
        expect(typeof msg.time).toBe("number");
      } finally {
        handler.unregister();
      }
    });

    it("preserves original console.error (chain not broken)", () => {
      const originalSpy = vi.fn();
      // eslint-disable-next-line no-console
      console.error = originalSpy;
      const { handler } = buildHandler();
      handler.register();
      try {
        // eslint-disable-next-line no-console
        console.error("preserve me");
        expect(originalSpy).toHaveBeenCalledTimes(1);
        expect(originalSpy.mock.calls[0]?.[0]).toBe("preserve me");
      } finally {
        handler.unregister();
      }
    });

    it("emits ERROR_CAPTURED marker", async () => {
      const { handler } = buildHandler();
      handler.register();
      try {
        // eslint-disable-next-line no-console
        console.error("marker check");
        // Allow microtask-flush so the synchronous emit + log path completes.
        await Promise.resolve();
        const events = (infoSpy.mock.calls as unknown[][])
          .map((c) => c[0])
          .filter((c): c is Record<string, unknown> => typeof c === "object" && c !== null);
        const captured = events.find((e) => e.event === "ERROR_CAPTURED");
        expect(captured).toBeDefined();
        expect(captured!.anchor).toBe("onError:BLOCK_FILTER");
        expect(captured!.module).toBe("M-ERROR-HANDLER");
      } finally {
        handler.unregister();
      }
    });
  });

  // ─── V-M-ERROR-HANDLER scenario-2 ──────────────────────────────────────────
  describe("scenario-2: window.error → emits ErrorMsgForSend", () => {
    it("captures via global addEventListener('error')", async () => {
      const { handler, bus } = buildHandler();
      handler.register();
      try {
        const first$ = firstValueFrom(handler.getMessagesStream().pipe(take(1)));
        const ev = makeErrorEvent({
          message: "boom from window",
          filename: "main.js",
          lineno: 42,
          colno: 7,
          error: new Error("inner"),
        });
        bus.dispatch("error", ev);
        const msg = await first$;
        expect(msg.src).toBe("ev");
        expect(msg.message).toBe("boom from window");
        expect(msg.details.k2).toBe("42");
        expect(msg.details.k3).toBe("main.js");
        expect(msg.details.k0).toContain("inner");
      } finally {
        handler.unregister();
      }
    });
  });

  // ─── V-M-ERROR-HANDLER scenario-3 ──────────────────────────────────────────
  describe("scenario-3: unhandledrejection → emits ErrorMsgForSend", () => {
    it("captures rejection reason as src='cpre'", async () => {
      const { handler, bus } = buildHandler();
      handler.register();
      try {
        const first$ = firstValueFrom(handler.getMessagesStream().pipe(take(1)));
        const reason = new Error("promise blew");
        bus.dispatch("unhandledrejection", makeRejectionEvent(reason));
        const msg = await first$;
        expect(msg.src).toBe("cpre");
        expect(msg.message).toBe("promise blew");
        expect(msg.details.k0).toBe("promise blew");
        expect(msg.details.k1).toContain("Error");
      } finally {
        handler.unregister();
      }
    });

    it("handles non-Error reason gracefully (string)", async () => {
      const { handler, bus } = buildHandler();
      handler.register();
      try {
        const first$ = firstValueFrom(handler.getMessagesStream().pipe(take(1)));
        bus.dispatch("unhandledrejection", makeRejectionEvent("string-reason"));
        const msg = await first$;
        expect(msg.src).toBe("cpre");
        expect(msg.message).toBe("string-reason");
      } finally {
        handler.unregister();
      }
    });
  });

  // ─── V-M-ERROR-HANDLER scenario-4 ──────────────────────────────────────────
  describe("scenario-4: 'File does not exist' noise filtered out", () => {
    it("drops messages containing the noise pattern", async () => {
      const { handler } = buildHandler();
      handler.register();
      try {
        // Subscribe and collect anything that DOES come through (should be the
        // second, non-noise message only).
        const collected$ = handler.getMessagesStream().pipe(take(1), toArray());
        const promise = firstValueFrom(collected$);
        // eslint-disable-next-line no-console
        console.error("File does not exist: foo.md");
        // eslint-disable-next-line no-console
        console.error("real-error: after noise");
        const arr = await promise;
        expect(arr).toHaveLength(1);
        expect(arr[0]!.message).toBe("real-error: after noise");
      } finally {
        handler.unregister();
      }
    });

    it("scans details.k0 / details.k1 for the pattern too", async () => {
      const { handler } = buildHandler();
      handler.register();
      try {
        const collected$ = handler.getMessagesStream().pipe(take(1), toArray());
        const promise = firstValueFrom(collected$);
        // Detail-position noise — first arg is a benign string, second arg
        // (k1) is the noisy one.
        // eslint-disable-next-line no-console
        console.error("benign headline", "File does not exist: a/b.md");
        // Now a real error.
        // eslint-disable-next-line no-console
        console.error("actual error");
        const arr = await promise;
        expect(arr).toHaveLength(1);
        expect(arr[0]!.message).toBe("actual error");
      } finally {
        handler.unregister();
      }
    });

    it("exposes NOISE_PATTERNS for inspection", () => {
      expect(NOISE_PATTERNS).toContain("File does not exist");
    });
  });

  // ─── V-M-ERROR-HANDLER scenario-5 ──────────────────────────────────────────
  describe("scenario-5: emitted errors also added to LOG-RING-BUFFER", () => {
    it("appends to the ring buffer with level='error'", async () => {
      const { handler, buffer } = buildHandler();
      handler.register();
      try {
        // eslint-disable-next-line no-console
        console.error("ring-buffer mirror test");
        await Promise.resolve();
        const lines = buffer.getSnapshot();
        expect(lines.length).toBeGreaterThanOrEqual(1);
        const last = lines.at(-1)!;
        expect(last.level).toBe("error");
        expect(last.event).toBe("ERROR_CAPTURED");
        expect(last.module).toBe("M-ERROR-HANDLER");
        expect(last.message).toBe("ring-buffer mirror test");
        expect(last.userAgent).toBe("test-agent/1.0");
      } finally {
        handler.unregister();
      }
    });

    it("does NOT mirror filtered-out noise", () => {
      const { handler, buffer } = buildHandler();
      handler.register();
      try {
        // eslint-disable-next-line no-console
        console.error("File does not exist: noise.md");
        expect(buffer.size()).toBe(0);
      } finally {
        handler.unregister();
      }
    });
  });

  // ─── V-M-ERROR-HANDLER scenario-6 ──────────────────────────────────────────
  describe("scenario-6 (integration): full register + intercept cycle", () => {
    it("captures one of each source, then unregister stops emissions", async () => {
      const { handler, buffer, bus } = buildHandler();
      handler.register();
      const seen: ErrorMsgForSend[] = [];
      const sub = handler.getMessagesStream().subscribe((m) => seen.push(m));
      try {
        // Console.
        // eslint-disable-next-line no-console
        console.error("from-console");
        // Window error.
        bus.dispatch("error", makeErrorEvent({ message: "from-window" }));
        // Unhandled rejection.
        bus.dispatch("unhandledrejection", makeRejectionEvent(new Error("from-promise")));

        await Promise.resolve();
        const sources = seen.map((m) => m.src);
        expect(sources).toContain("c");
        expect(sources).toContain("ev");
        expect(sources).toContain("cpre");
        // Ring-buffer should mirror all three.
        const lines = buffer.getSnapshot();
        expect(lines.length).toBe(3);
      } finally {
        sub.unsubscribe();
        handler.unregister();
      }

      // After unregister: emissions must STOP. We dispatch a window error and
      // expect no additional capture.
      const after$ = handler.getMessagesStream().subscribe((m) => seen.push(m));
      try {
        bus.dispatch("error", makeErrorEvent({ message: "post-unregister" }));
        await Promise.resolve();
        const countAfter = seen.filter((m) => m.message === "post-unregister").length;
        expect(countAfter).toBe(0);
        // Bus must have zero listeners for both event types.
        expect(bus.listenerCount("error")).toBe(0);
        expect(bus.listenerCount("unhandledrejection")).toBe(0);
      } finally {
        after$.unsubscribe();
      }
    });

    it("emits ERROR_HANDLER_REGISTERED log on register()", () => {
      const { handler } = buildHandler();
      handler.register();
      try {
        const events = (infoSpy.mock.calls as unknown[][])
          .map((c) => c[0])
          .filter((c): c is Record<string, unknown> => typeof c === "object" && c !== null);
        const registered = events.find((e) => e.event === "ERROR_HANDLER_REGISTERED");
        expect(registered).toBeDefined();
        expect(registered!.anchor).toBe("register");
        expect(registered!.module).toBe("M-ERROR-HANDLER");
      } finally {
        handler.unregister();
      }
    });

    it("register() is idempotent — calling twice is a no-op", () => {
      const { handler } = buildHandler();
      // Set up an original console.error so we can verify it survives both register() calls.
      const originalSpy = vi.fn();
      // eslint-disable-next-line no-console
      console.error = originalSpy;
      handler.register();
      handler.register();
      try {
        // eslint-disable-next-line no-console
        console.error("only-once");
        // Original should fire ONCE — even though register() ran twice.
        expect(originalSpy).toHaveBeenCalledTimes(1);
      } finally {
        handler.unregister();
      }
    });
  });

  // ─── Extra: manual emission ───────────────────────────────────────────────
  describe("emitManual()", () => {
    it("emits a synthetic ErrorMsgForSend with src='m'", async () => {
      const { handler, buffer } = buildHandler();
      handler.register();
      try {
        const first$ = firstValueFrom(handler.getMessagesStream().pipe(take(1)));
        handler.emitManual("synth", { detail: "x" });
        const msg = await first$;
        expect(msg.src).toBe("m");
        expect(msg.thread).toBe("main");
        expect(msg.message).toBe("synth");
        expect(msg.details.detail).toBe("x");
        // Ring-buffer mirrored too.
        expect(buffer.size()).toBeGreaterThanOrEqual(1);
      } finally {
        handler.unregister();
      }
    });
  });
});

// START_CHANGE_SUMMARY
// LAST_CHANGE: 2026-05-13 — initial test suite for V-M-ERROR-HANDLER
// END_CHANGE_SUMMARY
