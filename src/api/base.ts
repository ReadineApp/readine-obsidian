// START_MODULE_CONTRACT
// PURPOSE: HttpClient-like shim над obsidian.requestUrl: transformOptions inject AuthId + api-version headers; transformResult catches 401 → invokes registered logout callback (callback inversion to avoid cycle с M-AUTH-SERVICE).
// SCOPE: src/api/base.ts
// DEPENDS: M-HTTP-HELPER
// LINKS: UC-001, UC-003, UC-015, UC-016, UC-017, V-M-HTTP-BASE
// ROLE: RUNTIME
// END_MODULE_CONTRACT

// START_MODULE_MAP
// AUTH_ID_HEADER - HTTP header name carrying the session token ("AuthId")
// API_VERSION_HEADER - HTTP header name carrying the API version ("api-version")
// HttpHeadersLike - dictionary header bag interface returned by transformOptions
// HttpHeaders - case-sensitive header bag class
// HttpResponseBase - abstract base class for HTTP response objects
// HttpOptions - request options accepted by ApiClientBase.transformOptions / requestUrlAdapter
// HttpResponse - response envelope returned by requestUrlAdapter (mimics @angular/common/http HttpResponse for NSwag compatibility)
// ApiClientBaseConfiguration - DI-style config holder: apiBaseUrl, apiVersion, getAuthId() Promise, optional onLogout401 hook
// ApiClientBase - abstract base extended by NSwag-generated Client_V1_0; protected transformOptions/transformResult
// requestUrlAdapter - wraps obsidian.requestUrl Promise into an Observable<HttpResponse>
// registerLogout401Callback - register a global logout callback (callback inversion for M-AUTH-SERVICE)
// __resetLogout401CallbackForTests - test helper to clear the global callback between scenarios
// END_MODULE_MAP

import { Observable, from } from "rxjs";
import { requestUrl } from "obsidian";

// START_BLOCK_CONSTANTS
/** Header carrying the session token. Mirrors draft/reusable/api/base.ts. */
export const AUTH_ID_HEADER = "AuthId";

/** Header carrying the Readine API version (e.g. "1.0"). */
export const API_VERSION_HEADER = "api-version";

const MODULE_ID = "M-HTTP-BASE";
// END_BLOCK_CONSTANTS

// START_BLOCK_TYPES
/** Lightweight header bag. NSwag-generated code treats `options.headers` as a mutable dictionary. */
export type HttpHeadersLike = Record<string, string>;

/** Request options accepted by transformOptions / requestUrlAdapter. Matches the subset used by NSwag-generated clients. */
export interface HttpOptions {
  method?: string;
  body?: string | ArrayBuffer;
  headers?: HttpHeadersLike;
  /** NSwag passes "response" so the handler receives the full envelope. */
  observe?: "response" | "body";
  /** NSwag passes "blob" or "text"; the shim treats everything as text/ArrayBuffer. */
  responseType?: "blob" | "text" | "json" | "arraybuffer";
  /** Optional content-type for obsidian.requestUrl. */
  contentType?: string;
}

/** Response envelope. Carries .status so processors can branch the way NSwag-generated code expects. */
export interface HttpResponse<T = unknown> {
  status: number;
  headers: HttpHeadersLike;
  body: T;
  /** Raw text — useful for processors that want to re-parse JSON. */
  text?: string;
}

/**
 * Minimal case-sensitive header bag compatible with @angular/common/http HttpHeaders.
 * NSwag-generated calls touch only `new HttpHeaders({ "Content-Type": "application/json" })`.
 */
export class HttpHeaders {
  private readonly _map: Map<string, string>;

  constructor(init?: Record<string, string | string[]> | HttpHeaders | undefined) {
    this._map = new Map<string, string>();
    if (!init) return;
    if (init instanceof HttpHeaders) {
      for (const key of init.keys()) {
        const value = init.get(key);
        if (value !== null) this._map.set(key, value);
      }
      return;
    }
    for (const [key, raw] of Object.entries(init)) {
      if (Array.isArray(raw)) {
        this._map.set(key, raw.join(", "));
      } else if (typeof raw === "string") {
        this._map.set(key, raw);
      }
    }
  }

  set(key: string, value: string): HttpHeaders {
    this._map.set(key, value);
    return this;
  }

  get(key: string): string | null {
    return this._map.has(key) ? (this._map.get(key) as string) : null;
  }

  keys(): IterableIterator<string> {
    return this._map.keys();
  }

  has(key: string): boolean {
    return this._map.has(key);
  }

  delete(key: string): HttpHeaders {
    this._map.delete(key);
    return this;
  }

  append(key: string, value: string): HttpHeaders {
    const existing = this._map.get(key);
    this._map.set(key, existing ? `${existing}, ${value}` : value);
    return this;
  }

  toDict(): HttpHeadersLike {
    const out: HttpHeadersLike = {};
    for (const [k, v] of this._map.entries()) out[k] = v;
    return out;
  }
}

/**
 * Abstract response base. NSwag-generated processors run two checks:
 *   if (response_ instanceof HttpResponseBase) ...
 *   if (response instanceof HttpResponse) ...
 * Therefore `HttpResponse` (in angular-compat) extends `HttpResponseBase`.
 * The base carries `status` + `headers`; the concrete subclass adds `body`.
 */
export abstract class HttpResponseBase {
  public readonly status: number;
  public readonly headers: HttpHeaders;

  constructor(init: { status: number; headers?: HttpHeaders | HttpHeadersLike }) {
    this.status = init.status;
    this.headers =
      init.headers instanceof HttpHeaders
        ? init.headers
        : new HttpHeaders(init.headers ?? {});
  }
}
// END_BLOCK_TYPES

// START_BLOCK_INTERNAL_LOG
/**
 * Lightweight structured logger. Emits a single `console.<level>` call so tests
 * can assert required markers from `verification-plan.xml`.
 */
function logInfo(
  anchor: string,
  event: string,
  belief: string,
  requirement: string,
  details: Record<string, unknown> = {},
): void {
  console.debug({
    ts: new Date().toISOString(),
    level: "info",
    anchor,
    module: MODULE_ID,
    requirement,
    event,
    belief,
    ...details,
  });
}

function logWarn(
  anchor: string,
  event: string,
  belief: string,
  requirement: string,
  details: Record<string, unknown> = {},
): void {
  console.warn({
    ts: new Date().toISOString(),
    level: "warn",
    anchor,
    module: MODULE_ID,
    requirement,
    event,
    belief,
    ...details,
  });
}
// END_BLOCK_INTERNAL_LOG

// START_BLOCK_LOGOUT_CALLBACK_REGISTRY
/**
 * Global registry for the 401 logout callback. AuthService registers here on
 * construction; ApiClientBase invokes it from transformResult. Callback inversion
 * keeps the dependency chain M-AUTH-SERVICE → M-HTTP-BASE one-way (HTTP base
 * does not import AuthService).
 */
type Logout401Callback = () => void;

let _logout401Callback: Logout401Callback | null = null;

/**
 * START_CONTRACT: registerLogout401Callback
 * PURPOSE: register the global logout callback invoked when transformResult sees status 401
 * INPUTS: cb: () => void
 * OUTPUTS: void
 * SIDE_EFFECTS: stores cb in module-level slot, overwriting any previously registered callback
 * LINKS: UC-001, UC-015, V-M-HTTP-BASE
 * END_CONTRACT: registerLogout401Callback
 */
export function registerLogout401Callback(cb: Logout401Callback): void {
  _logout401Callback = cb;
}

/** Test-only helper. Production code never clears the callback after registration. */
export function __resetLogout401CallbackForTests(): void {
  _logout401Callback = null;
}
// END_BLOCK_LOGOUT_CALLBACK_REGISTRY

// START_BLOCK_REQUEST_ADAPTER
/**
 * START_CONTRACT: requestUrlAdapter
 * PURPOSE: adapt obsidian.requestUrl Promise to a single-emission Observable<HttpResponse>
 * INPUTS: url: string, options: HttpOptions (method, headers, body, contentType)
 * OUTPUTS: Observable<HttpResponse<string>> — emits the response envelope once, then completes
 * SIDE_EFFECTS: performs a network request via Obsidian's CORS-bypass channel
 * LINKS: UC-003, V-M-HTTP-BASE
 * END_CONTRACT: requestUrlAdapter
 */
export function requestUrlAdapter(
  url: string,
  options: HttpOptions = {},
): Observable<HttpResponse<string>> {
  const headers: HttpHeadersLike = options.headers ?? {};
  const param = {
    url,
    method: options.method ?? "GET",
    headers,
    body: options.body,
    contentType: options.contentType,
    throw: false,
  };

  logInfo(
    "requestUrlAdapter:BLOCK_REQUEST",
    "HTTP_REQUEST_START",
    "sending request via requestUrl",
    "UC-003",
    { url, method: options.method },
  );
  const promise = requestUrl(param).then(
    (res) => {
      const envelope: HttpResponse<string> = {
        status: res.status,
        headers: res.headers ?? {},
        body: res.text ?? "",
        text: res.text ?? "",
      };
      logInfo(
        "requestUrlAdapter:BLOCK_REQUEST",
        "HTTP_REQUEST_DONE",
        "requestUrl completed",
        "UC-003",
        {
          url,
          method: options.method,
          status: res.status,
          body: (res.text ?? "").substring(0, 1000),
        },
      );
      return envelope;
    },
    (err) => {
      logWarn(
        "requestUrlAdapter:BLOCK_REQUEST",
        "HTTP_REQUEST_FAILED",
        "requestUrl rejected with a network / TLS error",
        "UC-003",
        {
          url,
          method: options.method,
          errorType: (err as Error)?.name ?? typeof err,
          errorMessage: (err as Error)?.message ?? String(err),
          errorStatus: (err as { status?: unknown })?.status,
        },
      );
      throw err;
    },
  );
  return from(promise);
}
// END_BLOCK_REQUEST_ADAPTER

// START_BLOCK_CONFIGURATION
/**
 * START_CONTRACT: ApiClientBaseConfiguration
 * PURPOSE: hold DI-style config consumed by ApiClientBase
 * INPUTS: apiBaseUrl: string, apiVersion: string, getAuthId: () => Promise<string | null>, onLogout401?: () => void
 * OUTPUTS: instance
 * SIDE_EFFECTS: none
 * LINKS: UC-001, V-M-HTTP-BASE
 * END_CONTRACT: ApiClientBaseConfiguration
 */
export class ApiClientBaseConfiguration {
  constructor(
    public readonly apiBaseUrl: string,
    public readonly apiVersion: string,
    public readonly getAuthId: () => Promise<string | null>,
    public readonly onLogout401?: Logout401Callback,
  ) {}
}
// END_BLOCK_CONFIGURATION

// START_BLOCK_API_CLIENT_BASE
/**
 * Abstract base extended by NSwag-generated `Client_V1_0` (Phase 3). The base
 * provides two interception points that mirror the @angular/common/http NSwag
 * shape so the generator output works unchanged:
 *
 *  - `transformOptions(options)` returning Promise<HttpOptions> — NSwag wraps
 *     this with `from(...)` to fan into the request stream.
 *  - `transformResult(url, response, processor)` returning Observable<T>.
 *
 * The 401 hook prefers `config.onLogout401` (per-instance) and falls back to
 * the module-level registry populated by `registerLogout401Callback` — so the
 * plugin shell can wire AuthService once and any number of clients reuse it.
 */
export class ApiClientBase {
  constructor(public readonly config: ApiClientBaseConfiguration) {}

  // START_CONTRACT: transformOptions
  // PURPOSE: inject AuthId + api-version headers on every outgoing request
  // INPUTS: options: HttpOptions (mutated in-place — NSwag-generated callers expect this)
  // OUTPUTS: Promise<HttpOptions> — resolved with the same options post-mutation
  // SIDE_EFFECTS: reads AuthId via config.getAuthId(); emits HEADERS_INJECTED log marker
  // LINKS: UC-001, UC-017, V-M-HTTP-BASE
  // END_CONTRACT: transformOptions
  protected async transformOptions(options: HttpOptions): Promise<HttpOptions> {
    // START_BLOCK_INJECT_HEADERS
    const token = await this.config.getAuthId();
    const hdrs = options.headers instanceof HttpHeaders
      ? options.headers
      : new HttpHeaders(options.headers ?? {});
    hdrs.append(API_VERSION_HEADER, this.config.apiVersion);
    if (typeof token === "string" && token.length > 0) {
      hdrs.set(AUTH_ID_HEADER, token);
    }
    options.headers = hdrs.toDict();
    logInfo(
      "transformOptions:BLOCK_INJECT_HEADERS",
      "HEADERS_INJECTED",
      "AuthId + api-version added to outgoing request",
      "UC-001",
      { hasAuthId: typeof token === "string" && token.length > 0 },
    );
    return options;
    // END_BLOCK_INJECT_HEADERS
  }

  // START_CONTRACT: transformResult
  // PURPOSE: intercept HTTP response; on 401 invoke registered logout callback exactly once
  // INPUTS: url: string, response: HttpResponseBase, processor: (r: HttpResponseBase) => Observable<R>
  // OUTPUTS: Observable<R> — result of `processor(response)` after 401 inspection
  // SIDE_EFFECTS: may invoke onLogout401 callback; emits AUTH_401_DETECTED log marker on 401
  // LINKS: UC-001, UC-015, UC-016, V-M-HTTP-BASE
  // END_CONTRACT: transformResult
  protected transformResult<T, R>(
    url: string,
    response: HttpResponseBase,
    processor: (r: HttpResponseBase) => Observable<R>,
  ): Observable<R> {
    // START_BLOCK_CHECK_401
    if (response.status === 401) {
      logWarn(
        "transformResult:BLOCK_CHECK_401",
        "AUTH_401_DETECTED",
        "session expired — invoking logout callback",
        "UC-015",
        { url },
      );
      // Per-instance hook wins; otherwise fall back to module-level registry.
      const cb = this.config.onLogout401 ?? _logout401Callback;
      if (typeof cb === "function") {
        // Must run exactly once — NSwag-generated catch block re-invokes
        // transformResult on the SAME response, so we guard via a per-response
        // marker bit attached to the envelope. The marker survives the second
        // call but does not leak to other responses.
        if (!(response as unknown as HttpResponse<T> & { __logoutInvoked?: boolean }).__logoutInvoked) {
          (response as unknown as HttpResponse<T> & { __logoutInvoked?: boolean }).__logoutInvoked = true;
          cb();
        }
      }
    }
    // END_BLOCK_CHECK_401

    return processor(response);
  }
}
// END_BLOCK_API_CLIENT_BASE

// START_CHANGE_SUMMARY
// LAST_CHANGE: 2026-05-13 — initial implementation per Phase 2A
// LAST_CHANGE: 2026-06-01 — fix spread-bug: use HttpHeaders.append() + toDict() instead of blind object spread
// LAST_CHANGE: 2026-06-02 — add error logging in requestUrlAdapter for all HTTP failures
// LAST_CHANGE: 2026-06-02 — log outgoing requests (URL + method) at debug level before each request
// END_CHANGE_SUMMARY
