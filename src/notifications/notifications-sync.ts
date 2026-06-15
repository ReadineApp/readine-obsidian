// START_MODULE_CONTRACT
// PURPOSE: Fetch notifications delta from Readine API, apply to NotificationsStore, update watermark stamp. Queued user actions (MarkAsRead/Delete) are sent to the server on the next sync cycle. Runs in parallel with article sync via SyncOrchestrator. Stamp is persisted in a separate file by NotificationsStore — not in plugin settings.
// SCOPE: src/notifications/notifications-sync.ts
// DEPENDS: M-HTTP-CLIENT, M-AUTH-SERVICE, M-NOTIFICATIONS-STORE
// LINKS: UC-022, M-NOTIFICATIONS, V-M-NOTIFICATIONS
// ROLE: RUNTIME
// END_MODULE_CONTRACT

// START_MODULE_MAP
// NotificationsSyncApiClient - structural slice of Client_V1_0 (only apiNotificationsSync)
// NotificationsSyncDeps - DI bag
// NotificationsSync - class; sync() → Observable<void>
// END_MODULE_MAP

import { Observable, from, of } from "rxjs";
import { map, catchError, tap } from "rxjs/operators";
import { withRetry } from "../api/api-helper";
import { NOTIFICATIONS_SYNC_RETRIES, NOTIFICATIONS_SYNC_RETRY_DELAY_MS } from "../constants";
import { NotificationsStore, QueuedAction } from "./notifications-store";
import { SyncNotifications, SyncNotificationAction } from "../api/clientV1_0";
import { generateGuid } from "../utils/guid";

// START_BLOCK_TYPES
/**
 * Structural slice of the NSwag-generated Client_V1_0 — only the method(s)
 * consumed by M-NOTIFICATIONS. Decouples tests from the 10k-line generated file.
 */
export interface NotificationsSyncApiClient {
  apiNotificationsSync(body?: unknown): Observable<unknown>;
}

export interface NotificationsSyncDeps {
  store: NotificationsStore;
  apiClient: NotificationsSyncApiClient;
  pluginVersion: string;
}

/** Map local QueuedActionType to the server enum UserNotificationActionType (1 = MarkAsRead). */
function mapAction(action: QueuedAction["action"]): number {
  switch (action) {
    case "MarkAsRead":
      return 1;
    case "Delete":
      return 2;
  }
}
// END_BLOCK_TYPES

// START_CONTRACT: NotificationsSync
// PURPOSE: one-shot sync cycle: fetch delta, apply to store, stamp persisted via store.save()
// INPUTS: none (reads stamp from store)
// OUTPUTS: Observable<void>
// SIDE_EFFECTS: apiClient.apiNotificationsSync network call; store.setNotifications + store.stamp + store.save
// LINKS: UC-022, V-M-NOTIFICATIONS
// END_CONTRACT: NotificationsSync
export class NotificationsSync {
  private readonly _store: NotificationsStore;
  private readonly _apiClient: NotificationsSyncApiClient;
  private readonly _pluginVersion: string;
  private _cancelled = false;

  constructor(deps: NotificationsSyncDeps) {
    this._store = deps.store;
    this._apiClient = deps.apiClient;
    this._pluginVersion = deps.pluginVersion;
  }

  cancel(): void {
    this._cancelled = true;
  }

  isCancelled(): boolean {
    return this._cancelled;
  }

  sync(): Observable<void> {
    // START_BLOCK_FETCH
    const stamp = this._store.stamp;
    const actions = this._store.drainQueuedActions();
    const body = new SyncNotifications({
      lastSyncStamp: stamp,
      actions: actions.length > 0
        ? actions.map((a) => new SyncNotificationAction({
            notificationId: a.notificationId,
            action: mapAction(a.action),
          }))
        : [],
      clientRequestId: generateGuid(),
      cv: this._pluginVersion,
      forceFullUpdate: false,
    });

    if (this._cancelled) return of(undefined);

    return withRetry(this._apiClient.apiNotificationsSync(body), NOTIFICATIONS_SYNC_RETRIES, NOTIFICATIONS_SYNC_RETRY_DELAY_MS).pipe(
      map((raw: unknown) => {
        const result = raw as {
          syncStamp?: number;
          notifications?: Array<{
            notificationId?: string;
            isDeleted?: boolean;
            message?: string;
            wasRead?: boolean;
            createdUtc?: string;
          }>;
        };
        return result;
      }),
      tap((result) => {
        if (this._cancelled) return;
        if (result.notifications) {
          const records = result.notifications.map((n) => ({
            notificationId: n.notificationId ?? "",
            isDeleted: n.isDeleted,
            message: n.message,
            wasRead: n.wasRead,
            createdUtc: n.createdUtc ? new Date(n.createdUtc) : undefined,
          }));
          this._store.setNotifications(records);
        }
        if (result.syncStamp !== undefined && result.syncStamp !== null) {
          this._store.stamp = result.syncStamp;
        }
        void this._store.save();
      }),
      map(() => undefined),
      catchError((err) => {
        const httpStatus = err && typeof err === "object" && typeof (err as Record<string, unknown>).status === "number"
          ? (err as Record<string, unknown>).status
          : undefined;
        console.warn({
          ts: new Date().toISOString(),
          level: "warn",
          anchor: "NotificationsSync:BLOCK_FETCH",
          module: "M-NOTIFICATIONS",
          requirement: "UC-022",
          event: "NOTIFICATIONS_SYNC_FAILED",
          belief: "notifications fetch failed — will retry on next sync cycle",
          error: err instanceof Error ? err.message : String(err),
          httpStatus,
        });
        return of(undefined);
      }),
    );
  }
  // END_BLOCK_FETCH
}

// START_CHANGE_SUMMARY
// LAST_CHANGE: 2026-05-27 — initial M-NOTIFICATIONS sync logic
// LAST_CHANGE: 2026-06-04 — add withRetry (exponential backoff) + httpStatus in error log
// LAST_CHANGE: 2026-06-04 — replace plain-object body with SyncNotifications DTO; add pluginVersion dep; add clientRequestId/cv/forceFullUpdate
// LAST_CHANGE: 2026-06-07 — remove settings dependency; read/write stamp + notifications through file-backed NotificationsStore (stamp + save)
// END_CHANGE_SUMMARY
