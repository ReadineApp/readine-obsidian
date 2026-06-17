// START_MODULE_CONTRACT
// PURPOSE: Separate HttpClient-like shim for the Readine Logs API. transformOptions adds ONLY api-version (no AuthId); transformResult does NOT inspect 401. This channel must remain functional even when the user session is broken (UC-018).
// SCOPE: src/api/base-logs.ts
// DEPENDS: M-HTTP-HELPER
// LINKS: UC-018, V-M-HTTP-LOGS-BASE
// ROLE: RUNTIME
// END_MODULE_CONTRACT

// START_MODULE_MAP
// ApiClientLogsBaseConfiguration - DI config holder: apiBaseUrl, apiVersion (no AuthId, no logout callback)
// ApiClientLogsBase - abstract base for the NSwag-generated logs client; protected transformOptions/transformResult
// END_MODULE_MAP

import { Observable } from "rxjs";
import { HttpResponseBase } from "./base";
import {
  API_VERSION_HEADER,
  HttpHeaders,
  type HttpHeadersLike,
  type HttpOptions,
} from "./base";

// START_BLOCK_CONSTANTS
const MODULE_ID = "M-HTTP-LOGS-BASE";
// END_BLOCK_CONSTANTS

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

// START_BLOCK_CONFIGURATION
/**
 * START_CONTRACT: ApiClientLogsBaseConfiguration
 * PURPOSE: hold DI-style config for the logs API client
 * INPUTS: apiBaseUrl: string, apiVersion: string
 * OUTPUTS: instance
 * SIDE_EFFECTS: none
 * LINKS: UC-018, V-M-HTTP-LOGS-BASE
 * END_CONTRACT: ApiClientLogsBaseConfiguration
 */
export class ApiClientLogsBaseConfiguration {
  constructor(
    public readonly apiBaseUrl: string,
    public readonly apiVersion: string,
  ) {}
}
// END_BLOCK_CONFIGURATION

// START_BLOCK_API_CLIENT_LOGS_BASE
/**
 * Abstract base extended by the NSwag-generated logs client (Phase 3,
 * `Client_V1_0_Logs`). Distinguished from `ApiClientBase` by:
 *
 *  1. transformOptions NEVER touches the AuthId header — the logs channel is
 *     anonymous so it works even when the user session is broken.
 *  2. transformResult NEVER inspects status 401 — receiving a 401 from the
 *     logs API would otherwise re-trigger the logout cascade in a feedback
 *     loop. Errors propagate as ordinary Observable errors and the caller
 *     (M-ERROR-SENDER) decides whether to retry.
 */
export class ApiClientLogsBase {
  constructor(public readonly config: ApiClientLogsBaseConfiguration) {}

  // START_CONTRACT: transformOptions
  // PURPOSE: inject api-version header only; no AuthId
  // INPUTS: options: HttpOptions (mutated in-place)
  // OUTPUTS: Promise<HttpOptions>
  // SIDE_EFFECTS: emits LOGS_HEADERS_INJECTED log marker
  // LINKS: UC-018, V-M-HTTP-LOGS-BASE
  // END_CONTRACT: transformOptions
  protected async transformOptions(options: HttpOptions): Promise<HttpOptions> {
    // START_BLOCK_INJECT_HEADERS
    const hdrs = options.headers instanceof HttpHeaders
      ? options.headers
      : new HttpHeaders(options.headers ?? {});
    hdrs.append(API_VERSION_HEADER, this.config.apiVersion);
    options.headers = hdrs.toDict();
    logInfo(
      "transformOptions:BLOCK_INJECT_HEADERS",
      "LOGS_HEADERS_INJECTED",
      "api-version added; AuthId intentionally omitted",
    );
    return options;
    // END_BLOCK_INJECT_HEADERS
  }

  // START_CONTRACT: transformResult
  // PURPOSE: pass response straight through to the processor; never trigger logout
  // INPUTS: url: string, response: HttpResponseBase, processor: (r) => Observable<R>
  // OUTPUTS: Observable<R>
  // SIDE_EFFECTS: none — does NOT inspect 401, does NOT invoke any callback
  // LINKS: UC-018, V-M-HTTP-LOGS-BASE
  // END_CONTRACT: transformResult
  protected transformResult<T, R>(
    _url: string,
    response: HttpResponseBase,
    processor: (r: HttpResponseBase) => Observable<R>,
  ): Observable<R> {
    return processor(response);
  }
}
// END_BLOCK_API_CLIENT_LOGS_BASE

// START_CHANGE_SUMMARY
// LAST_CHANGE: 2026-05-13 — initial implementation per Phase 2A
// LAST_CHANGE: 2026-06-01 — fix spread-bug: use HttpHeaders.append() + toDict() instead of blind object spread
// END_CHANGE_SUMMARY
