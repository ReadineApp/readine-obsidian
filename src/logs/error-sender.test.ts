// START_MODULE_CONTRACT
// PURPOSE: Unit tests for M-ERROR-SENDER — bufferTime batching, payload assembly (incl. no-AuthId invariant), retry 3× with skip [401], failure swallow, full intercept→batch→POST integration cycle.
// SCOPE: src/logs/error-sender.test.ts
// DEPENDS: M-ERROR-SENDER, M-ERROR-HANDLER, M-HTTP-HELPER
// LINKS: V-M-ERROR-SENDER
// ROLE: TEST
// END_MODULE_CONTRACT

// START_MODULE_MAP
// (test file — no public exports)
// END_MODULE_MAP

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Observable, Subject, defer, of, throwError } from "rxjs";

vi.mock("obsidian", () => import("../__mocks__/obsidian"));

import { LogRingBuffer } from "./log-ring-buffer";
import {
  ErrorHandler,
  type ErrorMsgForSend,
  type PlatformLike as HandlerPlatformLike,
} from "./error-handler";
import {
  DEFAULT_BUFFER_MS,
  DEFAULT_RETRIES,
  DEFAULT_RETRY_DELAY_MS,
  ErrorSender,
  genRequestId,
  getDeviceInfo,
  stringToBase64,
  type AuthSourceLike,
  type ErrorSenderDeps,
  type LogsClientLike,
  type PlatformLike,
} from "./error-sender";

// START_BLOCK_FIXTURES
function buildPlatform(
  opts: { mobile?: boolean } = {},
): PlatformLike {
  const mobile = Boolean(opts.mobile);
  return {
    getPlatformLabel: () => mobile ? "Obsidian Mobile (iOS)" : "Obsidian Desktop (MacOS)",
    getDeviceInfo: () => ({
      platform: mobile ? "ios" as const : "web" as const,
      isVirtual: false,
      operatingSystem: mobile ? "ios" as const : "mac" as const,
      osVersion: mobile ? "17.3" : "10.15",
      webViewVersion: mobile ? "605.1.15" : "537.36",
      model: mobile ? "iPhone" : "Mac",
      manufacturer: "Apple",
    }),
    isMobile: () => mobile,
  };
}

function buildAuth(userId: string | null = null): AuthSourceLike {
  return { getUserId: () => userId };
}

function buildLogsClient(): {
  client: LogsClientLike;
  lastBody: { value: string | undefined };
  calls: { value: number };
  next: (impl: (body?: string) => Observable<void>) => void;
} {
  const lastBody: { value: string | undefined } = { value: undefined };
  const calls = { value: 0 };
  let impl: (body?: string) => Observable<void> = () => of(undefined as void);
  const client: LogsClientLike = {
    apiLS: vi.fn().mockImplementation((body?: string): Observable<void> => {
      lastBody.value = body;
      calls.value += 1;
      return impl(body);
    }),
  };
  return {
    client,
    lastBody,
    calls,
    next: (newImpl: (body?: string) => Observable<void>) => {
      impl = newImpl;
    },
  };
}

/**
 * Stand-in for the real ErrorHandler that exposes a Subject the test owns,
 * so we can push messages without dealing with the global console/window
 * interceptors. Cast to ErrorHandler in the deps bag — ErrorSender only calls
 * getMessagesStream() on it.
 */
class StubHandler {
  public readonly messages$ = new Subject<ErrorMsgForSend>();
  getMessagesStream() {
    return this.messages$.asObservable();
  }
}

function buildSender(
  overrides: Partial<ErrorSenderDeps> = {},
): {
  sender: ErrorSender;
  handler: StubHandler;
  logs: ReturnType<typeof buildLogsClient>;
  auth: AuthSourceLike;
} {
  const handler = new StubHandler();
  const logs = buildLogsClient();
  const auth = overrides.auth ?? buildAuth(null);
  const deps: ErrorSenderDeps = {
    handler: handler as unknown as ErrorHandler,
    logsClient: logs.client,
    auth,
    platform: overrides.platform ?? buildPlatform(),
    apiVersion: "1.0",
    bufferMs: overrides.bufferMs ?? DEFAULT_BUFFER_MS,
    retries: overrides.retries,
    retryDelayMs: overrides.retryDelayMs,
    ...overrides,
  };
  const sender = new ErrorSender(deps);
  return { sender, handler, logs, auth };
}

function makeMsg(message: string): ErrorMsgForSend {
  return {
    src: "c",
    thread: "main",
    message,
    details: { k0: message },
    time: Date.now(),
  };
}

function decodeBase64(b64: string): string {
  const buf = (globalThis as unknown as { Buffer?: { from: (s: string, enc: string) => { toString(enc: string): string } } }).Buffer;
  if (buf && typeof buf.from === "function") {
    return buf.from(b64, "base64").toString("utf-8");
  }
  // Browser fallback.
  return decodeURIComponent(escape(atob(b64)));
}
// END_BLOCK_FIXTURES

describe("M-ERROR-SENDER (V-M-ERROR-SENDER)", () => {
  let infoSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    infoSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // ─── V-M-ERROR-SENDER scenario-1 ───────────────────────────────────────────
  describe("scenario-1: bufferTime(500ms) groups errors into batches", () => {
    it("groups multiple errors into one upload", async () => {
      vi.useFakeTimers();
      const { sender, handler, logs } = buildSender();
      sender.register();

      // Emit 3 errors quickly — should all land in the same 500ms window.
      handler.messages$.next(makeMsg("a"));
      handler.messages$.next(makeMsg("b"));
      handler.messages$.next(makeMsg("c"));
      // Window not yet expired — no upload yet.
      expect(logs.calls.value).toBe(0);

      await vi.advanceTimersByTimeAsync(DEFAULT_BUFFER_MS);
      expect(logs.calls.value).toBe(1);

      const json = decodeBase64(logs.lastBody.value!);
      const payload = JSON.parse(json) as { messages: ErrorMsgForSend[] };
      expect(payload.messages).toHaveLength(3);
      expect(payload.messages.map((m) => m.message)).toEqual(["a", "b", "c"]);
      sender.unregister();
    });

    it("skips empty windows (no zero-length batches POSTed)", async () => {
      vi.useFakeTimers();
      const { sender, logs } = buildSender();
      sender.register();
      // No messages — advance 2 windows.
      await vi.advanceTimersByTimeAsync(DEFAULT_BUFFER_MS * 2);
      expect(logs.calls.value).toBe(0);
      sender.unregister();
    });
  });

  // ─── V-M-ERROR-SENDER scenario-2 ───────────────────────────────────────────
  describe("scenario-2: base64 payload correct shape", () => {
    it("includes reqId, v, device, messages — and omits user when logged out", async () => {
      vi.useFakeTimers();
      const { sender, handler, logs } = buildSender({
        auth: buildAuth(null),
        platform: buildPlatform({ mobile: false }),
      });
      sender.register();
      handler.messages$.next(makeMsg("hello"));
      await vi.advanceTimersByTimeAsync(DEFAULT_BUFFER_MS);

      const json = decodeBase64(logs.lastBody.value!);
      const payload = JSON.parse(json) as Record<string, unknown>;
      expect(typeof payload.reqId).toBe("string");
      expect((payload.reqId as string).startsWith("req_")).toBe(true);
      expect(payload.v).toBe("1.0");
      expect(payload.device).toEqual({
        platform: "web",
        isVirtual: false,
        operatingSystem: "mac",
        osVersion: "10.15",
        webViewVersion: "537.36",
        model: "Mac",
        manufacturer: "Apple",
      });
      expect(payload).not.toHaveProperty("user"); // critical: omitted, not null
      expect(Array.isArray(payload.messages)).toBe(true);
      sender.unregister();
    });

    it("includes user when AuthService has a userId", async () => {
      vi.useFakeTimers();
      const { sender, handler, logs } = buildSender({
        auth: buildAuth("user-Z"),
      });
      sender.register();
      handler.messages$.next(makeMsg("hi"));
      await vi.advanceTimersByTimeAsync(DEFAULT_BUFFER_MS);

      const json = decodeBase64(logs.lastBody.value!);
      const payload = JSON.parse(json) as Record<string, unknown>;
      expect(payload.user).toBe("user-Z");
      sender.unregister();
    });
  });

  // ─── V-M-ERROR-SENDER scenario-3 ───────────────────────────────────────────
  describe("scenario-3: POST /api/l/s called", () => {
    it("invokes logsClient.apiLS exactly once per non-empty batch", async () => {
      vi.useFakeTimers();
      const { sender, handler, logs } = buildSender();
      sender.register();
      handler.messages$.next(makeMsg("x"));
      await vi.advanceTimersByTimeAsync(DEFAULT_BUFFER_MS);
      expect(logs.client.apiLS).toHaveBeenCalledTimes(1);

      handler.messages$.next(makeMsg("y"));
      handler.messages$.next(makeMsg("z"));
      await vi.advanceTimersByTimeAsync(DEFAULT_BUFFER_MS);
      expect(logs.client.apiLS).toHaveBeenCalledTimes(2);
      sender.unregister();
    });

    it("emits ERROR_BATCH_FLUSHED + ERROR_UPLOAD_SUCCESS markers", async () => {
      vi.useFakeTimers();
      const { sender, handler } = buildSender();
      sender.register();
      handler.messages$.next(makeMsg("marker"));
      await vi.advanceTimersByTimeAsync(DEFAULT_BUFFER_MS);

      const events = (infoSpy.mock.calls as unknown[][])
        .map((c) => c[0])
        .filter((c): c is Record<string, unknown> => typeof c === "object" && c !== null);
      const flushed = events.find((e) => e.event === "ERROR_BATCH_FLUSHED");
      const success = events.find((e) => e.event === "ERROR_UPLOAD_SUCCESS");
      expect(flushed).toBeDefined();
      expect(flushed!.anchor).toBe("onBatch:BLOCK_ASSEMBLE");
      expect(success).toBeDefined();
      expect(success!.anchor).toBe("onBatch:BLOCK_POST");
      sender.unregister();
    });
  });

  // ─── V-M-ERROR-SENDER scenario-4 (CRITICAL INVARIANT) ──────────────────────
  describe("scenario-4: payload sent even when sessionId=null (no AuthId invariant)", () => {
    it("does NOT depend on auth.getUserId being set", async () => {
      vi.useFakeTimers();
      // Simulate an AuthService that's logged out — getUserId returns null.
      // The pipeline must still upload (Logs API is anonymous).
      const { sender, handler, logs } = buildSender({ auth: buildAuth(null) });
      sender.register();
      handler.messages$.next(makeMsg("anon-1"));
      handler.messages$.next(makeMsg("anon-2"));
      await vi.advanceTimersByTimeAsync(DEFAULT_BUFFER_MS);

      expect(logs.calls.value).toBe(1);
      const json = decodeBase64(logs.lastBody.value!);
      const payload = JSON.parse(json) as Record<string, unknown>;
      expect(payload).not.toHaveProperty("user");
      expect((payload.messages as ErrorMsgForSend[]).map((m) => m.message)).toEqual([
        "anon-1",
        "anon-2",
      ]);
      sender.unregister();
    });

    it("treats a thrown getUserId() the same as null", async () => {
      vi.useFakeTimers();
      const auth: AuthSourceLike = {
        getUserId: () => {
          throw new Error("auth not ready");
        },
      };
      const { sender, handler, logs } = buildSender({ auth });
      sender.register();
      handler.messages$.next(makeMsg("hello"));
      await vi.advanceTimersByTimeAsync(DEFAULT_BUFFER_MS);

      expect(logs.calls.value).toBe(1);
      const payload = JSON.parse(decodeBase64(logs.lastBody.value!)) as Record<string, unknown>;
      expect(payload).not.toHaveProperty("user");
      sender.unregister();
    });
  });

  // ─── V-M-ERROR-SENDER scenario-5 ───────────────────────────────────────────
  describe("scenario-5: retry 3× on network error", () => {
    it("retries until success on the 3rd attempt", async () => {
      vi.useFakeTimers();
      const { sender, handler, logs } = buildSender({
        retries: DEFAULT_RETRIES,
        retryDelayMs: DEFAULT_RETRY_DELAY_MS,
      });
      sender.register();

      let attempts = 0;
      logs.next(() =>
        defer(() => {
          attempts += 1;
          if (attempts < 3) {
            return throwError(() => ({ status: 503 }));
          }
          return of(undefined as void);
        }),
      );

      handler.messages$.next(makeMsg("retry-me"));
      await vi.advanceTimersByTimeAsync(DEFAULT_BUFFER_MS);
      // Retry 1: delay = Math.random() * DEFAULT_RETRY_DELAY_MS (0‑499ms).
      await vi.advanceTimersByTimeAsync(DEFAULT_RETRY_DELAY_MS);
      // Retry 2: delay = Math.random() * (DEFAULT_RETRY_DELAY_MS * 2) (0‑999ms).
      await vi.advanceTimersByTimeAsync(DEFAULT_RETRY_DELAY_MS * 2);
      expect(attempts).toBe(3);

      // No ERROR_UPLOAD_FAIL marker (we recovered).
      const events = (warnSpy.mock.calls as unknown[][])
        .map((c) => c[0])
        .filter((c): c is Record<string, unknown> => typeof c === "object" && c !== null);
      const failure = events.find((e) => e.event === "ERROR_UPLOAD_FAIL");
      expect(failure).toBeUndefined();
      sender.unregister();
    });

    it("gives up after N retries and emits ERROR_UPLOAD_FAIL (pipeline keeps running)", async () => {
      vi.useFakeTimers();
      const { sender, handler, logs } = buildSender({
        retries: 2,
        retryDelayMs: 100,
      });
      sender.register();

      // Always fail. Use `defer` so resubscription (which is how withRetry
      // implements its retry loop) re-runs the factory and increments `attempts`.
      let attempts = 0;
      logs.next(() =>
        defer(() => {
          attempts += 1;
          return throwError(() => ({ status: 500, message: "boom" }));
        }) as Observable<void>,
      );

      handler.messages$.next(makeMsg("doomed"));
      await vi.advanceTimersByTimeAsync(DEFAULT_BUFFER_MS);
      // Retry 1: exponential backoff — delay = Math.random() * 100ms → 0‑99ms.
      await vi.advanceTimersByTimeAsync(100);
      // Retry 2: delay = Math.random() * 200ms → 0‑199ms.
      await vi.advanceTimersByTimeAsync(200);
      // 1 initial + 2 retries = 3 total attempts.
      expect(attempts).toBe(3);

      const events = (warnSpy.mock.calls as unknown[][])
        .map((c) => c[0])
        .filter((c): c is Record<string, unknown> => typeof c === "object" && c !== null);
      const failure = events.find((e) => e.event === "ERROR_UPLOAD_FAIL");
      expect(failure).toBeDefined();
      expect(failure!.anchor).toBe("onBatch:BLOCK_POST");

      // After failure: pipeline keeps running and a subsequent successful
      // upload still happens.
      const callsBefore = logs.calls.value;
      logs.next(() => of(undefined as void));
      handler.messages$.next(makeMsg("recovered"));
      await vi.advanceTimersByTimeAsync(DEFAULT_BUFFER_MS);
      expect(logs.calls.value).toBe(callsBefore + 1);
      sender.unregister();
    });
  });

  // ─── V-M-ERROR-SENDER scenario-6 ───────────────────────────────────────────
  describe("scenario-6: NO retry on 401 (skipStatuses=[401])", () => {
    it("bails immediately on a 401 and does NOT retry", async () => {
      vi.useFakeTimers();
      const { sender, handler, logs } = buildSender({
        retries: 3,
        retryDelayMs: 10,
      });
      sender.register();

      let attempts = 0;
      logs.next(() => {
        attempts += 1;
        return throwError(() => ({ status: 401, message: "unauthorized" })) as Observable<void>;
      });

      handler.messages$.next(makeMsg("forbidden"));
      await vi.advanceTimersByTimeAsync(DEFAULT_BUFFER_MS);
      await vi.advanceTimersByTimeAsync(50);
      expect(attempts).toBe(1);
      const events = (warnSpy.mock.calls as unknown[][])
        .map((c) => c[0])
        .filter((c): c is Record<string, unknown> => typeof c === "object" && c !== null);
      const failure = events.find((e) => e.event === "ERROR_UPLOAD_FAIL");
      expect(failure).toBeDefined();
      sender.unregister();
    });
  });

  // ─── V-M-ERROR-SENDER scenario-7 (INTEGRATION) ─────────────────────────────
  describe("scenario-7 (integration): full intercept → batch → POST cycle with mock LogsClient", () => {
    it("real ErrorHandler → console.error → batched → POST", async () => {
      vi.useFakeTimers();
      const buffer = new LogRingBuffer(50);
      const platform: HandlerPlatformLike = { getPlatformLabel: () => "ua/1" };
      const handler = new ErrorHandler({
        ringBuffer: buffer,
        platform,
      });
      handler.register();

      const logs = buildLogsClient();
      const auth = buildAuth("user-Z");
      const sender = new ErrorSender({
        handler,
        logsClient: logs.client,
        auth,
        platform: {
          getPlatformLabel: () => "ua/1",
          getDeviceInfo: () => ({
            platform: "web" as const, isVirtual: false, operatingSystem: "unknown" as const,
            osVersion: "", webViewVersion: "", model: "unknown", manufacturer: "unknown",
          }),
          isMobile: () => false,
        },
        apiVersion: "1.0",
        bufferMs: DEFAULT_BUFFER_MS,
      });
      sender.register();

      // eslint-disable-next-line no-console
      console.error("integration-1");
      // eslint-disable-next-line no-console
      console.error("integration-2");
      await vi.advanceTimersByTimeAsync(DEFAULT_BUFFER_MS);

      expect(logs.client.apiLS).toHaveBeenCalledTimes(1);
      const json = decodeBase64(logs.lastBody.value!);
      const payload = JSON.parse(json) as { user: string; messages: ErrorMsgForSend[] };
      expect(payload.user).toBe("user-Z");
      expect(payload.messages.map((m) => m.message)).toEqual([
        "integration-1",
        "integration-2",
      ]);
      // Ring-buffer also mirrored both (UC-019 link).
      expect(buffer.size()).toBe(2);

      sender.unregister();
      handler.unregister();
    });
  });

  // ─── helper exports ────────────────────────────────────────────────────────
  describe("helper exports", () => {
    it("genRequestId returns a 'req_' prefix and is unique per call", () => {
      const a = genRequestId();
      const b = genRequestId();
      expect(a).toMatch(/^req_/);
      expect(b).toMatch(/^req_/);
      expect(a).not.toBe(b);
    });

    it("getDeviceInfo returns device info via platform.getDeviceInfo()", () => {
      const info = getDeviceInfo(buildPlatform({ mobile: true }));
      expect(info.platform).toBe("ios");
      expect(info.operatingSystem).toBe("ios");
      expect(info.osVersion).toBe("17.3");
      expect(info.webViewVersion).toBe("605.1.15");
      expect(info.model).toBe("iPhone");
      expect(info.manufacturer).toBe("Apple");
      expect(info.isVirtual).toBe(false);
    });

    it("stringToBase64 round-trips UTF-8", () => {
      const s = "héllo, wörld — ☃";
      const b64 = stringToBase64(s);
      expect(decodeBase64(b64)).toBe(s);
    });

    it("exposes DEFAULT_BUFFER_MS = 500, DEFAULT_RETRIES = 3, DEFAULT_RETRY_DELAY_MS = 500", () => {
      expect(DEFAULT_BUFFER_MS).toBe(500);
      expect(DEFAULT_RETRIES).toBe(3);
      expect(DEFAULT_RETRY_DELAY_MS).toBe(500);
    });
  });

  // ─── lifecycle ─────────────────────────────────────────────────────────────
  describe("register/unregister lifecycle", () => {
    it("register() is idempotent", () => {
      const { sender } = buildSender();
      sender.register();
      sender.register();
      expect(sender.__isRegisteredForTests()).toBe(true);
      sender.unregister();
      expect(sender.__isRegisteredForTests()).toBe(false);
    });

    it("unregister() before register() is a no-op", () => {
      const { sender } = buildSender();
      expect(() => sender.unregister()).not.toThrow();
      expect(sender.__isRegisteredForTests()).toBe(false);
    });
  });
});

// START_CHANGE_SUMMARY
// LAST_CHANGE: 2026-05-13 — initial test suite for V-M-ERROR-SENDER
// END_CHANGE_SUMMARY
