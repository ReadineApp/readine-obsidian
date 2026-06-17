// START_MODULE_CONTRACT
// PURPOSE: Global error pipeline — installs interceptors around console.error / window.error / unhandledrejection, packages each captured event into an ErrorMsgForSend DTO, emits it on an internal RxJS ReplaySubject(50) (consumed by M-ERROR-SENDER), and mirrors a sanitized copy into M-LOG-RING-BUFFER for UC-019 support bundles. Filters "File does not exist" noise per draft/reusable/settings/error.handler.service.ts. Designed to be installed FIRST in plugin.onload so it captures startup failures from other modules; ReplaySubject buffers up to 50 messages until ErrorSender subscribes.
// SCOPE: src/logs/error-handler.ts
// DEPENDS: M-LOG-RING-BUFFER, M-PLATFORM
// LINKS: UC-018, UC-019, V-M-ERROR-HANDLER
// ROLE: RUNTIME
// END_MODULE_CONTRACT

// START_MODULE_MAP
// ErrorMsgForSend - DTO type for the Logs API payload {src, thread, message, details, time}
// ErrorSource - union of allowed src field values ('c' | 'm' | 'ev' | 'cpre')
// ErrorHandler - class: register() / unregister() / getMessagesStream() / emitManual()
// ErrorHandlerDeps - DI bag (ringBuffer + platform module slice)
// PlatformLike - minimal platform slice used here (getUserAgent for ring-buffer enrichment)
// GlobalEventBusLike - minimal slice of the global window/eventTarget used to attach window.error + unhandledrejection listeners (kept structural for testability)
// NOISE_PATTERNS - exported filter list (currently ['File does not exist'])
// END_MODULE_MAP

import { Observable, ReplaySubject } from "rxjs";

import type { LogRingBuffer } from "./log-ring-buffer";

// START_BLOCK_CONSTANTS
const MODULE_ID = "M-ERROR-HANDLER";

/**
 * String-literal union of the recognized error-source codes. Mirrors the
 * draft/reusable convention (src='c' for captured console, 'ev' for window
 * error event, 'cpre' for caught Promise rejection event, 'm' for manual).
 */
export type ErrorSource = "c" | "m" | "ev" | "cpre";

/**
 * Substrings that mark a message as noise — we drop these BEFORE emitting on
 * messages$ so the Logs API does not see them. Currently the only entry is
 * Obsidian's "File does not exist" warning, which fires on benign reads.
 */
export const NOISE_PATTERNS: readonly string[] = ["File does not exist"] as const;
// END_BLOCK_CONSTANTS

// START_BLOCK_TYPES
/**
 * DTO posted to the Readine Logs API (`/api/l/s`). Shape preserved from
 * draft/reusable/settings/errorMsgForSend.ts. Keep field names short — they
 * are wire-format.
 */
export interface ErrorMsgForSend {
  /** Source channel: 'c'=console.error, 'ev'=window.error, 'cpre'=unhandledrejection, 'm'=manual. */
  src: ErrorSource;
  /** Logical thread label (main / worker-name). Always 'main' in Obsidian. */
  thread: string;
  /** Top-line message. */
  message: string;
  /** Free-form key/value extras (stack, filename, lineno, ...). */
  details: Record<string, string>;
  /** Epoch-ms timestamp. */
  time: number;
}

/**
 * Minimal slice of M-PLATFORM consumed by the error handler. Bridge so tests
 * can stub without importing the real `obsidian` mock.
 */
export interface PlatformLike {
  getPlatformLabel(): string;
}

/**
 * Structural slice of the global event-bus surface (window in the browser,
 * `globalThis` in JSDOM, or a test-supplied EventTarget). Decoupling from
 * `window` lets us run under vitest's `environment: "node"` without a DOM.
 */
export interface GlobalEventBusLike {
  addEventListener(
    type: string,
    listener: (ev: Event) => void,
    options?: boolean | { capture?: boolean },
  ): void;
  removeEventListener(
    type: string,
    listener: (ev: Event) => void,
    options?: boolean | { capture?: boolean },
  ): void;
}

export interface ErrorHandlerDeps {
  ringBuffer: LogRingBuffer;
  platform: PlatformLike;
  /**
   * Optional global bus override. Falls back to `globalThis` when both
   * addEventListener and removeEventListener are functions; otherwise the
   * window-error / unhandledrejection branches are disabled (the console.error
   * branch still works — useful for headless tests).
   */
  globalBus?: GlobalEventBusLike;
}
// END_BLOCK_TYPES

// START_BLOCK_INTERNAL_LOG
function logInfo(
  anchor: string,
  event: string,
  belief: string,
  details: Record<string, unknown> = {},
): void {
  console.debug({
    ts: new Date().toISOString(),
    level: "info",
    anchor,
    module: MODULE_ID,
    requirement: "UC-018",
    event,
    belief,
    ...details,
  });
}
// END_BLOCK_INTERNAL_LOG

// START_BLOCK_ERROR_HANDLER
/**
 * Global error pipeline. Single instance owned by M-PLUGIN-MAIN. register()
 * installs three interceptors; unregister() restores the original console.error
 * and removes window listeners. NEVER emits the captured message until after
 * the noise filter has cleared it, so M-ERROR-SENDER only sees actionable data.
 *
 * INVARIANTS:
 *   - register() is idempotent — calling twice without unregister() is a no-op.
 *   - console.error chain is preserved: the ORIGINAL console.error always runs,
 *     so devtools / piped logs see the same content they used to.
 *   - The "File does not exist" filter applies BEFORE both ring-buffer mirror
 *     and messages$ emit, matching draft behavior.
 */
export class ErrorHandler {
  private readonly deps: ErrorHandlerDeps;
  private readonly messages$ = new ReplaySubject<ErrorMsgForSend>(50);
  private originalConsoleError: typeof console.error | null = null;
  private windowErrorListener:
    | ((ev: ErrorEvent) => void)
    | null = null;
  private unhandledRejectionListener:
    | ((ev: PromiseRejectionEvent) => void)
    | null = null;
  private registered = false;

  // START_CONTRACT: constructor
  // PURPOSE: build an ErrorHandler bound to its ring-buffer + platform dependencies
  // INPUTS: deps: ErrorHandlerDeps
  // OUTPUTS: instance — interceptors NOT installed until register() is called
  // SIDE_EFFECTS: none until register()
  // LINKS: UC-018, V-M-ERROR-HANDLER
  // END_CONTRACT: constructor
  constructor(deps: ErrorHandlerDeps) {
    this.deps = deps;
  }

  // START_CONTRACT: register
  // PURPOSE: install console.error wrapper + window.error + unhandledrejection listeners
  // INPUTS: none
  // OUTPUTS: void
  // SIDE_EFFECTS: mutates global console.error; adds two window listeners; flips registered=true
  // LINKS: UC-018, V-M-ERROR-HANDLER
  // END_CONTRACT: register
  register(): void {
    if (this.registered) return;

    // START_BLOCK_INSTALL_CONSOLE
    // Wrap console.error so the ORIGINAL is always called (preserves the chain),
    // then capture into our pipeline.
    this.originalConsoleError = console.error;
    const orig = this.originalConsoleError;
    console.error = (...args: unknown[]): void => {
      // Always run the original first — otherwise devtools / structured-log
      // tests downstream lose their stream.
      try {
        orig.apply(console, args as []);
      } catch {
        // Original may throw if console was replaced again — swallow.
      }
      try {
        this.onConsoleError(args);
      } catch {
        // Never let our handler abort the call site.
      }
    };
    // END_BLOCK_INSTALL_CONSOLE

    // START_BLOCK_INSTALL_WINDOW
    const bus = this.resolveBus();
    if (bus !== null) {
      this.windowErrorListener = (ev: ErrorEvent) => {
        try {
          this.onWindowError(ev);
        } catch {
          // ignore
        }
      };
      bus.addEventListener(
        "error",
        this.windowErrorListener as (e: Event) => void,
        true,
      );

      this.unhandledRejectionListener = (ev: PromiseRejectionEvent) => {
        try {
          this.onUnhandledRejection(ev);
        } catch {
          // ignore
        }
      };
      bus.addEventListener(
        "unhandledrejection",
        this.unhandledRejectionListener as (e: Event) => void,
      );
    }
    // END_BLOCK_INSTALL_WINDOW

    this.registered = true;
    logInfo(
      "register",
      "ERROR_HANDLER_REGISTERED",
      "console.error wrapped, window.error + unhandledrejection installed",
    );
  }

  // START_CONTRACT: unregister
  // PURPOSE: revert console.error + remove window listeners (plugin.onunload)
  // INPUTS: none
  // OUTPUTS: void
  // SIDE_EFFECTS: restores console.error; removeEventListener for the two installed listeners; flips registered=false
  // LINKS: UC-018, V-M-ERROR-HANDLER
  // END_CONTRACT: unregister
  unregister(): void {
    if (!this.registered) return;

    if (this.originalConsoleError) {
      console.error = this.originalConsoleError;
      this.originalConsoleError = null;
    }

    const bus = this.resolveBus();
    if (bus !== null) {
      if (this.windowErrorListener) {
        bus.removeEventListener(
          "error",
          this.windowErrorListener as (e: Event) => void,
          true,
        );
        this.windowErrorListener = null;
      }
      if (this.unhandledRejectionListener) {
        bus.removeEventListener(
          "unhandledrejection",
          this.unhandledRejectionListener as (e: Event) => void,
        );
        this.unhandledRejectionListener = null;
      }
    }

    this.registered = false;
  }

  // START_CONTRACT: getMessagesStream
  // PURPOSE: expose the captured-error stream for subscription by M-ERROR-SENDER
  // INPUTS: none
  // OUTPUTS: Observable<ErrorMsgForSend>
  // SIDE_EFFECTS: none
  // LINKS: UC-018, V-M-ERROR-HANDLER
  // END_CONTRACT: getMessagesStream
  getMessagesStream(): Observable<ErrorMsgForSend> {
    return this.messages$.asObservable();
  }

  // START_CONTRACT: emitManual
  // PURPOSE: programmatic synthesis of an ErrorMsgForSend (used by M-PLUGIN-MAIN for cross-cutting traces)
  // INPUTS: message: string, details?: Record<string,string>
  // OUTPUTS: void
  // SIDE_EFFECTS: emits ErrorMsgForSend on messages$ + ring-buffer mirror; respects noise filter
  // LINKS: UC-018, V-M-ERROR-HANDLER
  // END_CONTRACT: emitManual
  emitManual(message: string, details: Record<string, string> = {}): void {
    this.emit("m", "main", message, details);
  }

  // ─── Internal capture branches ─────────────────────────────────────────────

  private onConsoleError(args: unknown[]): void {
    // The wrapping function receives the variadic argument list straight from
    // the call-site. We mirror the original draft semantics by indexing each
    // arg into "k<i>", picking the first one as the headline.
    const details: Record<string, string> = {};
    for (let i = 0; i < args.length; i += 1) {
      details[`k${i}`] = stringifyArg(args[i]);
    }
    const headline = stringifyArg(args[0]) || "console.error";
    this.emit("c", "main", headline, details);
  }

  private onWindowError(ev: ErrorEvent): void {
    const details: Record<string, string> = {
      k0: stringifyArg(ev.error),
      k1: typeof ev.colno === "number" ? String(ev.colno) : "",
      k2: typeof ev.lineno === "number" ? String(ev.lineno) : "",
      k3: typeof ev.filename === "string" ? ev.filename : "",
    };
    const headline = typeof ev.message === "string" && ev.message.length > 0
      ? ev.message
      : "window.error";
    this.emit("ev", "main", headline, details);
  }

  private onUnhandledRejection(ev: PromiseRejectionEvent): void {
    const reason = ev.reason as unknown;
    const details: Record<string, string> = {
      k0: extractMessage(reason),
      k1: extractStack(reason),
    };
    const headline = extractMessage(reason) || "unhandledrejection";
    this.emit("cpre", "main", headline, details);
  }

  private emit(
    src: ErrorSource,
    thread: string,
    message: string,
    details: Record<string, string>,
  ): void {
    // START_BLOCK_FILTER
    if (isNoise(message, details)) {
      // Note: we deliberately do NOT mirror to ring-buffer either — the noise
      // filter is end-to-end (matches draft semantics).
      return;
    }
    // END_BLOCK_FILTER

    const msg: ErrorMsgForSend = {
      src,
      thread,
      message,
      details,
      time: Date.now(),
    };

    // START_BLOCK_MIRROR_AND_EMIT
    try {
      this.deps.ringBuffer.addLine({
        ts: new Date(msg.time).toISOString(),
        level: "error",
        anchor: "onError:BLOCK_FILTER",
        module: MODULE_ID,
        requirement: "UC-018",
        event: "ERROR_CAPTURED",
        belief: "error packaged for Logs API",
        message: msg.message,
        src: msg.src,
        thread: msg.thread,
        userAgent: this.deps.platform.getPlatformLabel(),
      });
    } catch {
      // Ring-buffer failures are non-fatal; the message still goes to messages$.
    }
    this.messages$.next(msg);
    logInfo(
      "onError:BLOCK_FILTER",
      "ERROR_CAPTURED",
      "error passed noise filter; emitted to messages$ + ring-buffer",
      { src, thread, len: message.length },
    );
    // END_BLOCK_MIRROR_AND_EMIT
  }

  /** Test-only — true after register() and before unregister(). */
  __isRegisteredForTests(): boolean {
    return this.registered;
  }

  /**
   * Resolve the global event-bus once per call. Prefers the DI override; falls
   * back to `globalThis` only when both add/removeEventListener are functions.
   * Returns null when no usable bus is available (e.g. headless Node without
   * polyfills) — in that mode only the console.error branch is active.
   */
  private resolveBus(): GlobalEventBusLike | null {
    const candidate = this.deps.globalBus ?? (globalThis as unknown as Partial<GlobalEventBusLike>);
    if (
      candidate &&
      typeof candidate.addEventListener === "function" &&
      typeof candidate.removeEventListener === "function"
    ) {
      return candidate as GlobalEventBusLike;
    }
    return null;
  }
}
// END_BLOCK_ERROR_HANDLER

// START_BLOCK_HELPERS
function isNoise(message: string, details: Record<string, string>): boolean {
  for (const pattern of NOISE_PATTERNS) {
    if (message.includes(pattern)) return true;
    // Also scan the first two detail slots — matches draft semantics.
    const k0 = details.k0 ?? "";
    const k1 = details.k1 ?? "";
    if (k0.includes(pattern) || k1.includes(pattern)) return true;
  }
  return false;
}

function stringifyArg(arg: unknown): string {
  if (arg === null) return "null";
  if (arg === undefined) return "undefined";
  if (typeof arg === "string") return arg;
  if (typeof arg === "number" || typeof arg === "boolean") return String(arg);
  if (arg instanceof Error) {
    return arg.message;
  }
  if (typeof arg === "object") {
    try {
      return JSON.stringify(arg);
    } catch {
      return Object.prototype.toString.call(arg);
    }
  }
  // bigint / symbol / function
  try {
    return String(arg);
  } catch {
    return "";
  }
}

function extractMessage(reason: unknown): string {
  if (reason === null || reason === undefined) return "";
  if (typeof reason === "string") return reason;
  if (reason instanceof Error) return reason.message;
  if (typeof reason === "object") {
    const obj = reason as { message?: unknown };
    if (typeof obj.message === "string") return obj.message;
    try {
      return JSON.stringify(reason);
    } catch {
      return "";
    }
  }
  return String(reason);
}

function extractStack(reason: unknown): string {
  if (reason instanceof Error && typeof reason.stack === "string") {
    return reason.stack;
  }
  if (reason && typeof reason === "object") {
    const obj = reason as { stack?: unknown };
    if (typeof obj.stack === "string") return obj.stack;
  }
  return "";
}
// END_BLOCK_HELPERS

// START_CHANGE_SUMMARY
// LAST_CHANGE: 2026-05-13 — initial implementation per Phase 4
// LAST_CHANGE: 2026-06-01 — Subject→ReplaySubject(50) to fix race condition on startup
// END_CHANGE_SUMMARY
