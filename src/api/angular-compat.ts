// START_MODULE_CONTRACT
// PURPOSE: Drop-in compatibility shim that lets the NSwag-generated `Client_V1_0` / `Client_V1_0_Logs` files run unchanged in this Obsidian plugin. The NSwag emit hard-codes imports from `@angular/common/http` and `@angular/core`; we redirect those imports here, where each Angular symbol is re-implemented in vanilla TypeScript on top of M-HTTP-BASE / M-HTTP-LOGS-BASE.
// SCOPE: src/api/angular-compat.ts
// DEPENDS: M-HTTP-BASE, M-HTTP-LOGS-BASE
// LINKS: UC-001, UC-003, UC-018, V-M-HTTP-BASE
// ROLE: RUNTIME
// END_MODULE_CONTRACT

// START_MODULE_MAP
// HttpHeaders - case-sensitive header bag mimicking @angular/common/http HttpHeaders (constructor, set, get, keys, has, delete, append)
// HttpResponseBase - abstract base carrying status + headers; runtime-checked via `instanceof`
// HttpResponse - generic concrete response with .body; subclass of HttpResponseBase
// HttpClient - minimal request(method, url, options) wrapper that delegates to requestUrlAdapter and wraps the envelope as an HttpResponse
// Injectable - no-op decorator factory (DI metadata is unused at runtime here)
// Inject - no-op parameter decorator
// Optional - no-op parameter decorator
// InjectionToken - minimal class carrying a debug name (tokens are passed but not resolved)
// ApiClientBase - re-export of M-HTTP-BASE.ApiClientBase (NSwag generated client extends it)
// ApiClientBaseConfiguration - re-export of M-HTTP-BASE config token (NSwag DI symbol)
// ApiClientLogsBase - re-export of M-HTTP-LOGS-BASE.ApiClientLogsBase (NSwag generated logs client extends it)
// ApiClientLogsBaseConfiguration - re-export of M-HTTP-LOGS-BASE config token (NSwag DI symbol)
// END_MODULE_MAP

import { Observable, map } from "rxjs";
import {
  requestUrlAdapter,
  HttpHeaders,
  HttpResponseBase,
  type HttpHeadersLike,
  type HttpOptions,
  type HttpResponse as ShimHttpResponse,
} from "./base";

// START_BLOCK_HTTP_RESPONSE
export class HttpResponse<T = unknown> extends HttpResponseBase {
  public readonly body: T | null;

  constructor(init: {
    status: number;
    headers?: HttpHeaders | HttpHeadersLike;
    body?: T | null;
  }) {
    super({ status: init.status, headers: init.headers });
    this.body = init.body ?? null;
  }
}
// END_BLOCK_HTTP_RESPONSE

// START_BLOCK_HTTP_CLIENT
/**
 * START_CONTRACT: HttpClient
 * PURPOSE: drop-in replacement for @angular/common/http HttpClient consumed by NSwag-generated Client_V1_0 / Client_V1_0_Logs
 * INPUTS: request(method: string, url: string, options: any)
 * OUTPUTS: Observable<HttpResponse<string>> — single emission, mirrors the `observe: "response"` shape used by NSwag
 * SIDE_EFFECTS: performs network request via M-HTTP-BASE.requestUrlAdapter (obsidian.requestUrl under the hood)
 * LINKS: UC-001, UC-003, UC-018, V-M-HTTP-BASE
 * END_CONTRACT: HttpClient
 *
 * NSwag callers always pass `options: { body, headers, observe: "response", responseType: "blob" }`.
 * We ignore `responseType: "blob"` and treat everything as text — `blobToText` inside the generated
 * client tolerates string input because its first branch is `if (!blob) { observer.next(""); }`
 * and otherwise calls `reader.readAsText(blob)` which we side-step by returning the text envelope.
 */
export class HttpClient {
  request(
    method: string,
    url: string,
    options: {
      body?: unknown;
      headers?: HttpHeaders | HttpHeadersLike;
      observe?: "response" | "body";
      responseType?: "blob" | "text" | "json" | "arraybuffer";
      contentType?: string;
    } = {},
  ): Observable<HttpResponse<string>> {
    // START_BLOCK_NORMALIZE_OPTIONS
    const headersDict: HttpHeadersLike =
      options.headers instanceof HttpHeaders
        ? options.headers.toDict()
        : { ...(options.headers ?? {}) };
    const body =
      typeof options.body === "string" || options.body instanceof ArrayBuffer
        ? (options.body as string | ArrayBuffer)
        : options.body === undefined || options.body === null
          ? undefined
          : String(options.body);
    const shimOptions: HttpOptions = {
      method: method.toUpperCase(),
      headers: headersDict,
      body,
      contentType: options.contentType,
      observe: options.observe,
      responseType: options.responseType,
    };
    // END_BLOCK_NORMALIZE_OPTIONS

    // START_BLOCK_DELEGATE
    // Map the shim envelope (plain object) into a `HttpResponse` instance so
    // NSwag's `instanceof HttpResponseBase` / `instanceof HttpResponse` checks
    // succeed inside generated processors.
    return requestUrlAdapter(url, shimOptions).pipe(
      map((envelope: ShimHttpResponse<string>) =>
        new HttpResponse<string>({
          status: envelope.status,
          headers: new HttpHeaders(envelope.headers),
          body: envelope.body,
        }),
      ),
    );
    // END_BLOCK_DELEGATE
  }
}
// END_BLOCK_HTTP_CLIENT

// START_BLOCK_DI_STUBS
/**
 * No-op DI decorators. NSwag emits `@Injectable()` on the class and `@Inject(Token)` /
 * `@Optional()` on constructor parameters. None of those run-time hooks are actually
 * consumed here — the plugin shell instantiates clients via `new Client_V1_0(config, http)`
 * directly — so the decorators are reduced to identity functions.
 *
 * Each decorator is typed as `any` because parameter decorators and class decorators have
 * incompatible signatures in TypeScript; using a permissive any keeps the NSwag emit
 * type-checking happy without enabling experimentalDecorators.
 */

// Class-decorator factory: `@Injectable()` is emitted as a call, returning the actual decorator.
export function Injectable(): ClassDecorator {
  return (_target: object) => {
    // intentional no-op
  };
}

// Parameter-decorator factory: `@Inject(Token)` returns a decorator that ignores its arguments.
export function Inject(_token: unknown): ParameterDecorator {
  return (
    _target: object,
    _propertyKey: string | symbol | undefined,
    _parameterIndex: number,
  ) => {
    // intentional no-op
  };
}

// Parameter decorator: `@Optional()` marks the next param as optional (we already model that via `?`).
export function Optional(): ParameterDecorator {
  return (
    _target: object,
    _propertyKey: string | symbol | undefined,
    _parameterIndex: number,
  ) => {
    // intentional no-op
  };
}

/**
 * Stand-in for @angular/core's InjectionToken. Generated code uses it only as a tag:
 *
 *   export const API_BASE_URL = new InjectionToken<string>("API_BASE_URL");
 *
 * The plugin shell ignores the token and passes the base URL directly to the constructor.
 */
export class InjectionToken<T = unknown> {
  // The phantom `_brand` keeps the generic parameter from being collapsed away
  // by structural typing — important because NSwag emits parameter types like
  // `@Inject(API_BASE_URL) baseUrl?: string` that rely on InjectionToken<T>'s nominal shape.
  private readonly _brand?: T;
  constructor(public readonly _desc: string) {
    // intentional no-op
    void this._brand;
  }
}
// END_BLOCK_DI_STUBS

// START_BLOCK_LOGS_BASE_REEXPORT
/**
 * NSwag-generated `client-v1-0-logs.ts` imports `ApiClientLogsBase` and
 * `ApiClientLogsBaseConfiguration` from `./base_logs` (underscore!). Our shim
 * file is `./base-logs` (dash). The path-rewrite step in the import-substitution
 * pipeline normalizes the underscore to a dash, but if a future regeneration
 * drifts we keep the re-exports here so the surface is stable.
 */
export {
  ApiClientBase,
  ApiClientBaseConfiguration,
  HttpHeaders,
  HttpResponseBase,
} from "./base";
export {
  ApiClientLogsBase,
  ApiClientLogsBaseConfiguration,
} from "./base-logs";
// END_BLOCK_LOGS_BASE_REEXPORT

// START_CHANGE_SUMMARY
// LAST_CHANGE: 2026-05-13 — initial Phase 3 angular compatibility shim
// END_CHANGE_SUMMARY
