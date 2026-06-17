// START_MODULE_CONTRACT
// PURPOSE: Generic retry-with-exponential-backoff wrapper for any HTTP-like Observable. Skips configurable HTTP statuses (default: [401]). Logs each retry attempt via console.debug.
// SCOPE: src/api/api-helper.ts
// DEPENDS: none
// LINKS: UC-003, UC-018, V-M-HTTP-HELPER
// ROLE: RUNTIME
// END_MODULE_CONTRACT

// START_MODULE_MAP
// withRetry - wrap an Observable with N retries + exponential backoff (full jitter); bail immediately on skipStatuses
// DEFAULT_SKIP_STATUSES - [401] — 401 is propagated immediately so AuthService can react
// MIN_429_DELAY_MS - 10s floor delay for 429 Too Many Requests
// END_MODULE_MAP

import { Observable, of, throwError } from "rxjs";
import { delay, mergeMap, retryWhen } from "rxjs/operators";

// START_BLOCK_CONSTANTS
/** Default list of HTTP statuses that must NOT be retried. 401 → AuthService.logout401 fires. */
export const DEFAULT_SKIP_STATUSES: readonly number[] = [401] as const;

/**
 * Minimum delay (ms) for 429 Too Many Requests — matches the observed server
 * quota window of 10 s. Ensures at least one retry falls outside the window.
 */
export const MIN_429_DELAY_MS = 10_000;
// END_BLOCK_CONSTANTS

// START_BLOCK_TYPES
/** Loose shape used for the typed error inspection below. */
interface HttpErrorLike {
  status?: number;
}

function getStatus(err: unknown): number | undefined {
  if (err && typeof err === "object" && "status" in err) {
    const v = (err as HttpErrorLike).status;
    if (typeof v === "number") return v;
  }
  return undefined;
}
// END_BLOCK_TYPES

// START_CONTRACT: withRetry
// PURPOSE: wrap an Observable with N retries + exponential backoff (full jitter: random 0..base*2^attempt); bail immediately on skipStatuses. For 429 Too Many Requests the delay has a 10 s floor (MIN_429_DELAY_MS) to respect the server quota window.
// INPUTS: observable: Observable<T>, retries: number (≥0), delayMs: number (≥0) — base delay for exponential backoff, skipStatuses?: number[]
// OUTPUTS: Observable<T> — emits the same values; retries up to N times on transient errors
// SIDE_EFFECTS: writes retry-attempt debug log via console.debug
// LINKS: UC-003, UC-018, V-M-HTTP-HELPER
// END_CONTRACT: withRetry
export function withRetry<T>(
  observable: Observable<T>,
  retries: number,
  delayMs: number,
  skipStatuses: readonly number[] = DEFAULT_SKIP_STATUSES,
): Observable<T> {
  if (!Number.isFinite(retries) || retries < 0) {
    throw new Error("withRetry: retries must be a non-negative integer");
  }
  if (!Number.isFinite(delayMs) || delayMs < 0) {
    throw new Error("withRetry: delayMs must be a non-negative integer");
  }

  // START_BLOCK_RETRY_PIPE
  let remaining = retries;
  let attempt = 0;
  return observable.pipe(
    retryWhen((errors$) =>
      errors$.pipe(
        mergeMap((err: unknown) => {
          const status = getStatus(err);
          if (typeof status === "number" && skipStatuses.includes(status)) {
            return throwError(() => err);
          }
          if (remaining <= 0) {
            return throwError(() => err);
          }
          remaining -= 1;
          const thisAttempt = attempt;
          attempt += 1;
          const base = delayMs * 2 ** thisAttempt;
          const minDelay = status === 429 ? MIN_429_DELAY_MS : 0;
          const clamped = Math.max(base, minDelay);
          const jittered = Math.random() * clamped;
          console.debug({
            ts: new Date().toISOString(),
            level: "debug",
            anchor: "withRetry:BLOCK_RETRY_PIPE",
            module: "M-HTTP-HELPER",
            requirement: "UC-003",
            event: "RETRY_ATTEMPT",
            belief: "retrying with exponential backoff",
            attempt: thisAttempt + 1,
            maxRetries: retries,
            baseDelayMs: delayMs,
            actualDelayMs: Math.round(jittered),
            httpStatus: status ?? null,
            minDelayApplied: status === 429,
          });
          return of(err).pipe(delay(jittered));
        }),
      ),
    ),
  );
  // END_BLOCK_RETRY_PIPE
}

// START_CHANGE_SUMMARY
// LAST_CHANGE: 2026-05-13 — initial implementation per Phase 2A
// LAST_CHANGE: 2026-06-04 — exponential backoff (full jitter) + retry debug log; contract updated from fixed delay
// LAST_CHANGE: 2026-06-04 — MIN_429_DELAY_MS = 10s floor for 429 Too Many Requests
// END_CHANGE_SUMMARY
