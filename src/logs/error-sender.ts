// START_MODULE_CONTRACT
// PURPOSE: Batched upload of captured errors to the Readine Logs API. Subscribes to M-ERROR-HANDLER.messages$, buffers via bufferTime(500ms), assembles a {reqId, v, device, user?, messages[]} envelope, base64-encodes the JSON, and POSTs via M-HTTP-LOGS-CLIENT (apiLS). Retries 3× with 500ms backoff via M-HTTP-HELPER.withRetry, skipping 401 (the logs channel must remain functional even when the user session is broken — UC-018 invariant). Decoupled from M-HTTP-BASE entirely: AuthService is consulted only for an OPTIONAL userId; absence of a token does NOT block the upload.
// SCOPE: src/logs/error-sender.ts
// DEPENDS: M-ERROR-HANDLER, M-HTTP-LOGS-CLIENT, M-HTTP-HELPER, M-AUTH-SERVICE, M-PLATFORM
// LINKS: UC-018, V-M-ERROR-SENDER
// ROLE: RUNTIME
// END_MODULE_CONTRACT

// START_MODULE_MAP
// ErrorSender - class: register() / unregister(); subscribes to handler.getMessagesStream()
// ErrorSenderDeps - DI bag (handler + logsClient + auth + platform + apiVersion)
// LogsClientLike - minimal slice of NSwag Client_V1_0_Logs (only apiLS)
// AuthSourceLike - minimal slice of AuthService.getUserId()
// PlatformLike - minimal platform slice used here (getUserAgent + isMobile + getPlatform for device info)
// LogsUploadPayload - DTO assembled per batch ({reqId, v, device, user?, messages[]}) before base64 encoding
// DeviceInfo - sub-DTO of LogsUploadPayload describing userAgent + isMobile + platform
// OperatingSystem - union type: 'ios'|'android'|'windows'|'mac'|'unknown'
// stringToBase64 - utility wrapping the binary-safe TextEncoder + btoa pipeline (kept exported for V-M-ERROR-SENDER scenarios)
// genRequestId - generate per-batch correlation id
// getDeviceInfo - assemble {userAgent, platform, isMobile} payload
// DEFAULT_BUFFER_MS - exported constant (500ms)
// DEFAULT_RETRIES - exported constant (3)
// DEFAULT_RETRY_DELAY_MS - exported constant (500)
// END_MODULE_MAP

import {
  EMPTY,
  Observable,
  Subscription,
  catchError,
  filter,
  mergeMap,
  of,
} from "rxjs";
import { bufferTime } from "rxjs/operators";

import { withRetry } from "../api/api-helper";
import type { ErrorHandler, ErrorMsgForSend } from "./error-handler";

// START_BLOCK_CONSTANTS
const MODULE_ID = "M-ERROR-SENDER";

/** bufferTime window — matches §13 / UC-018 spec (500ms). */
export const DEFAULT_BUFFER_MS = 500;
/** Retry attempts for the apiLS POST. */
export const DEFAULT_RETRIES = 3;
/** Per-retry delay in ms (linear backoff). */
export const DEFAULT_RETRY_DELAY_MS = 500;
// END_BLOCK_CONSTANTS

// START_BLOCK_TYPES
/**
 * Structural slice of the NSwag-generated `Client_V1_0_Logs`. Only the apiLS
 * method is consumed here, so we keep the dependency surface tiny and trivially
 * stubbable in tests.
 */
export interface LogsClientLike {
  apiLS(body?: string | undefined): Observable<void>;
}

/**
 * Structural slice of M-AUTH-SERVICE consumed by ErrorSender. Only getUserId
 * is needed — the logs channel intentionally does NOT pass the session token
 * (UC-018: works even when the user is signed out).
 */
export interface AuthSourceLike {
  getUserId(): string | null;
}

export interface PlatformLike {
  getUserAgent(): string;
  isMobile?(): boolean;
}

export interface ErrorSenderDeps {
  handler: ErrorHandler;
  logsClient: LogsClientLike;
  auth: AuthSourceLike;
  platform: PlatformLike;
  /** Forwarded to payload.v — keeps the server side able to differentiate plugin versions. */
  apiVersion: string;
  /** Optional override for testing (smaller window). */
  bufferMs?: number;
  retries?: number;
  retryDelayMs?: number;
}

/**
 * Shape posted to /api/l/s. Field names are short because they are wire-format
 * and the Logs API has a strict schema (see draft/reusable/api/clientV1_0.Logs.ts).
 */
export interface LogsUploadPayload {
  reqId: string;
  v: string;
  device: DeviceInfo;
  /** undefined when the user is logged out — must NOT be the string "null". */
  user?: string;
  messages: ErrorMsgForSend[];
}

export type OperatingSystem = 'ios' | 'android' | 'windows' | 'mac' | 'unknown';
export interface DeviceInfo {
  /**
   * The name of the device. For example, "John's iPhone".
   *
   * This is only supported on iOS and Android 7.1 or above.
   *
   * On iOS 16+ this will return a generic device name without the appropriate [entitlements](https://developer.apple.com/documentation/bundleresources/entitlements/com_apple_developer_device-information_user-assigned-device-name).
   *
   * @since 1.0.0
   */
  name?: string;
  /**
   * The device model. For example, "iPhone13,4".
   *
   * @since 1.0.0
   */
  model: string;
  /**
   * The device platform (lowercase).
   *
   * @since 1.0.0
   */
  platform: 'ios' | 'android' | 'web';
  /**
   * The operating system of the device.
   *
   * @since 1.0.0
   */
  operatingSystem: OperatingSystem;
  /**
   * The version of the device OS.
   *
   * @since 1.0.0
   */
  osVersion: string;
  /**
   * The iOS version number.
   *
   * Only available on iOS.
   *
   * Multi-part version numbers are crushed down into an integer padded to two-digits, ex: `"16.3.1"` -> `160301`
   *
   * @since 5.0.0
   */
  iOSVersion?: number;
  /**
   * The Android SDK version number.
   *
   * Only available on Android.
   *
   * @since 5.0.0
   */
  androidSDKVersion?: number;
  /**
   * The manufacturer of the device.
   *
   * @since 1.0.0
   */
  manufacturer: string;
  /**
   * Whether the app is running in a simulator/emulator.
   *
   * @since 1.0.0
   */
  isVirtual: boolean;
  /**
   * Approximate memory used by the current app, in bytes. Divide by
   * 1048576 to get the number of MBs used.
   *
   * @since 1.0.0
   */
  memUsed?: number;
  /**
   * The web view browser version
   *
   * @since 1.0.0
   */
  webViewVersion: string;
}
// END_BLOCK_TYPES

// START_BLOCK_INTERNAL_LOG
function logInfo(
  anchor: string,
  event: string,
  belief: string,
  details: Record<string, unknown> = {},
): void {
  // eslint-disable-next-line no-console
  console.debug({
    ts: new Date().toISOString(),
    level: "debug",
    anchor,
    module: MODULE_ID,
    requirement: "UC-018",
    event,
    belief,
    ...details,
  });
}

function logWarn(
  anchor: string,
  event: string,
  belief: string,
  details: Record<string, unknown> = {},
): void {
  // eslint-disable-next-line no-console
  console.warn({
    ts: new Date().toISOString(),
    level: "warn",
    anchor,
    module: MODULE_ID,
    requirement: "UC-018",
    event,
    belief,
    ...details,
  });
}
// END_BLOCK_INTERNAL_LOG

// START_BLOCK_HELPERS
/**
 * Stable per-batch correlation id. Format mirrors `Utils.genRequestId` from
 * the draft (`req_<random>_<ts>` style — short enough for query strings, long
 * enough for de-dup). NOT cryptographically secure; only correlation, not auth.
 */
export function genRequestId(): string {
  const rand = Math.random().toString(36).slice(2, 10);
  const ts = Date.now().toString(36);
  return `req_${rand}${ts}`;
}

/**
 * Assemble the device-info dictionary. The Logs API uses these fields for
 * platform-level aggregation (mobile-vs-desktop error rates, OS string).
 */
export function getDeviceInfo(platform: PlatformLike): DeviceInfo {
  const ua = platform.getUserAgent();
  const mobile = typeof platform.isMobile === "function" ? platform.isMobile() : false;
  const osInfo = parseOSFromUA(ua);
  return {
    platform: mobile ? (osInfo.ios ? "ios" : osInfo.android ? "android" : "web") : "web",
    isVirtual: false,
    operatingSystem: osInfo.os,
    osVersion: osInfo.version,
    webViewVersion: osInfo.webView,
    model: osInfo.model || "unknown",
    manufacturer: osInfo.manufacturer || "unknown",
  };
}

function parseOSFromUA(ua: string): {
  ios: boolean;
  android: boolean;
  os: OperatingSystem;
  version: string;
  webView: string;
  model: string;
  manufacturer: string;
} {
  const iosMatch = ua.match(/iPhone OS (\d+[_\d]*)/);
  const iosModel = /(iPhone|iPad|iPod)/.exec(ua);
  const androidMatch = ua.match(/Android (\d+[\.\d]*)/);
  const androidModel = /Android \d[\.\d]*; ([^;)]+)/.exec(ua);
  const macMatch = ua.match(/Mac OS X (\d+[_\d]*)/);
  const webViewMatch = ua.match(/AppleWebKit\/(\S+)/);
  const winMatch = ua.match(/Windows NT (\d+[\.\d]*)/);
  if (iosMatch) {
    return {
      ios: true, android: false, os: "ios",
      version: iosMatch[1]?.replace(/_/g, ".") ?? "",
      webView: webViewMatch?.[1] ?? "",
      model: iosModel?.[1] ?? "iPhone",
      manufacturer: "Apple",
    };
  }
  if (androidMatch) {
    const chromeVer = ua.match(/Chrome\/(\S+)/);
    return {
      ios: false, android: true, os: "android",
      version: androidMatch[1] ?? "",
      webView: chromeVer?.[1] ?? "",
      model: androidModel?.[1]?.trim() ?? "unknown",
      manufacturer: "unknown",
    };
  }
  if (macMatch) {
    return {
      ios: false, android: false, os: "mac",
      version: macMatch[1]?.replace(/_/g, ".") ?? "",
      webView: webViewMatch?.[1] ?? "",
      model: "Mac",
      manufacturer: "Apple",
    };
  }
  if (winMatch) {
    return {
      ios: false, android: false, os: "windows",
      version: winMatch[1] ?? "", webView: "",
      model: "PC", manufacturer: "Microsoft",
    };
  }
  return {
    ios: false, android: false, os: "unknown",
    version: "", webView: "", model: "unknown", manufacturer: "unknown",
  };
}

/**
 * Base64-encode a string using a runtime-agnostic path. In the Obsidian
 * (Electron) environment `Buffer` is available; in pure browser it falls back
 * to `btoa`. Both produce the same wire format.
 */
export function stringToBase64(input: string): string {
  if (typeof globalThis !== "undefined") {
    const buf = (globalThis as unknown as { Buffer?: { from: (s: string, enc: string) => { toString(enc: string): string } } }).Buffer;
    if (buf && typeof buf.from === "function") {
      return buf.from(input, "utf-8").toString("base64");
    }
  }
  if (typeof btoa === "function") {
    // btoa wants binary string — escape non-ASCII to keep parity with Buffer.
    const bytes = new TextEncoder().encode(input);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]!);
    }
    return btoa(binary);
  }
  // Last-resort: spec-compliant base64 of the UTF-8 bytes — see RFC 4648.
  // We don't expect to hit this branch in production, but tests can run in
  // sandboxed environments without either Buffer or btoa.
  return base64Fallback(input);
}

function base64Fallback(input: string): string {
  const bytes = new TextEncoder().encode(input);
  const chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let out = "";
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const a = bytes[i]!;
    const b = bytes[i + 1]!;
    const c = bytes[i + 2]!;
    out += chars[a >> 2]!;
    out += chars[((a & 0x03) << 4) | (b >> 4)]!;
    out += chars[((b & 0x0f) << 2) | (c >> 6)]!;
    out += chars[c & 0x3f]!;
  }
  if (i < bytes.length) {
    const a = bytes[i]!;
    out += chars[a >> 2]!;
    if (i + 1 < bytes.length) {
      const b = bytes[i + 1]!;
      out += chars[((a & 0x03) << 4) | (b >> 4)]!;
      out += chars[(b & 0x0f) << 2]!;
      out += "=";
    } else {
      out += chars[(a & 0x03) << 4]!;
      out += "==";
    }
  }
  return out;
}
// END_BLOCK_HELPERS

// START_BLOCK_ERROR_SENDER
/**
 * Batched uploader. register() wires the pipeline; unregister() tears it down
 * (plugin.onunload). Survives a broken session: the Logs API is anonymous, so
 * we deliberately pass `user` only when AuthService has a userId.
 *
 * Pipeline:
 *   handler.messages$
 *     .pipe(bufferTime(500))
 *     .pipe(filter(batch => batch.length > 0))
 *     .pipe(mergeMap(batch => this.send(batch)))
 *     .subscribe()
 */
export class ErrorSender {
  private readonly deps: ErrorSenderDeps;
  private subscription: Subscription | null = null;
  private cachedDevice: DeviceInfo | null = null;

  // START_CONTRACT: constructor
  // PURPOSE: build an ErrorSender bound to its five collaborators
  // INPUTS: deps: ErrorSenderDeps
  // OUTPUTS: instance — pipeline NOT subscribed until register() is called
  // SIDE_EFFECTS: none until register()
  // LINKS: UC-018, V-M-ERROR-SENDER
  // END_CONTRACT: constructor
  constructor(deps: ErrorSenderDeps) {
    this.deps = deps;
  }

  // START_CONTRACT: register
  // PURPOSE: subscribe to handler.messages$ and start the batched upload pipeline
  // INPUTS: none
  // OUTPUTS: void
  // SIDE_EFFECTS: creates an RxJS subscription stored on the instance
  // LINKS: UC-018, V-M-ERROR-SENDER
  // END_CONTRACT: register
  register(): void {
    if (this.subscription) return; // idempotent

    this.cachedDevice = getDeviceInfo(this.deps.platform);
    const bufferMs = this.deps.bufferMs ?? DEFAULT_BUFFER_MS;
    this.subscription = this.deps.handler
      .getMessagesStream()
      .pipe(
        bufferTime(bufferMs),
        filter((batch): batch is ErrorMsgForSend[] => Array.isArray(batch) && batch.length > 0),
        mergeMap((batch) => this.send(batch)),
      )
      .subscribe({
        error: (err) => {
          logWarn(
            "register:SUBSCRIPTION",
            "ERROR_SENDER_SUBSCRIBE_ERROR",
            "unexpected synchronous error in sender pipeline",
            { err: serializeErr(err) },
          );
        },
      });
  }

  // START_CONTRACT: unregister
  // PURPOSE: tear down the pipeline subscription (plugin.onunload)
  // INPUTS: none
  // OUTPUTS: void
  // SIDE_EFFECTS: unsubscribes the internal pipeline; flushes nothing
  // LINKS: UC-018, V-M-ERROR-SENDER
  // END_CONTRACT: unregister
  unregister(): void {
    if (this.subscription) {
      this.subscription.unsubscribe();
      this.subscription = null;
    }
  }

  // START_CONTRACT: send
  // PURPOSE: assemble a payload for one batch and POST it (with retry) to the Logs API
  // INPUTS: batch: ErrorMsgForSend[]
  // OUTPUTS: Observable<void> — emits once after the request settles; never errors out (catchError swallows + logs)
  // SIDE_EFFECTS: invokes logsClient.apiLS; emits ERROR_BATCH_FLUSHED / ERROR_UPLOAD_SUCCESS / ERROR_UPLOAD_FAIL markers
  // LINKS: UC-018, V-M-ERROR-SENDER
  // END_CONTRACT: send
  private send(batch: ErrorMsgForSend[]): Observable<void> {
    // START_BLOCK_ASSEMBLE
    const userId = safeGetUserId(this.deps.auth);
    const payload: LogsUploadPayload = {
      reqId: genRequestId(),
      v: this.deps.apiVersion,
      device: this.cachedDevice ?? getDeviceInfo(this.deps.platform),
      messages: batch,
    };

    // CRITICAL INVARIANT (UC-018): user field is included ONLY when userId is
    // a non-empty string. Absence is signalled by omitting the key entirely —
    // the server treats `null` and "" differently from undefined.
    if (typeof userId === "string" && userId.length > 0) {
      payload.user = userId;
    }
    const jsonStr = JSON.stringify(payload);
    const b64 = stringToBase64(jsonStr);
    logInfo(
      "onBatch:BLOCK_ASSEMBLE",
      "ERROR_BATCH_FLUSHED",
      "batch encoded and ready to POST",
      { reqId: payload.reqId, size: batch.length, hasUser: payload.user !== undefined },
    );
    // END_BLOCK_ASSEMBLE

    // START_BLOCK_POST
    const retries = this.deps.retries ?? DEFAULT_RETRIES;
    const delayMs = this.deps.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
    return withRetry(this.deps.logsClient.apiLS(b64), retries, delayMs, [401]).pipe(
      mergeMap(() => {
        logInfo(
          "onBatch:BLOCK_POST",
          "ERROR_UPLOAD_SUCCESS",
          "apiLS responded OK",
          { reqId: payload.reqId, size: batch.length },
        );
        return of(undefined as void);
      }),
      catchError((err: unknown) => {
        logWarn(
          "onBatch:BLOCK_POST",
          "ERROR_UPLOAD_FAIL",
          "apiLS POST failed after retries",
          { reqId: payload.reqId, size: batch.length, err: serializeErr(err) },
        );
        // Swallow — the upload pipeline must keep running for subsequent batches.
        return EMPTY;
      }),
    );
    // END_BLOCK_POST
  }

  /** Test-only — true after register() and before unregister(). */
  __isRegisteredForTests(): boolean {
    return this.subscription !== null;
  }
}
// END_BLOCK_ERROR_SENDER

// START_BLOCK_AUX
function safeGetUserId(auth: AuthSourceLike): string | null {
  try {
    return auth.getUserId();
  } catch {
    return null;
  }
}

function serializeErr(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return Object.prototype.toString.call(err);
  }
}
// END_BLOCK_AUX

// START_CHANGE_SUMMARY
// LAST_CHANGE: 2026-05-13 — initial implementation per Phase 4
// LAST_CHANGE: 2026-06-01 — logInfo: console.info → console.debug
// LAST_CHANGE: 2026-06-01 — unescape→TextEncoder in stringToBase64; add error handler to .subscribe()
// LAST_CHANGE: 2026-06-01 — DeviceInfo: add operatingSystem/osVersion/webViewVersion fields from UA parsing
// END_CHANGE_SUMMARY
