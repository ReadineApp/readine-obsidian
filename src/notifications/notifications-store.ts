// START_MODULE_CONTRACT
// PURPOSE: File-backed reactive store for notifications. Wraps a BehaviorSubject<NotificationRecord[]>, persisted to a dedicated JSON file (like ArticleRegistry). Stores both the sync stamp and notification records — stamp survives reload, so sync delta resumes correctly. Exposes get/set/markAsRead/markAllAsRead/drainQueuedActions/load/save.
// SCOPE: src/notifications/notifications-store.ts
// DEPENDS: M-VAULT-FILE-STORAGE (IFileStorage)
// LINKS: UC-022, M-NOTIFICATIONS, V-M-NOTIFICATIONS
// ROLE: RUNTIME
// END_MODULE_CONTRACT

// START_MODULE_MAP
// NotificationRecord - re-exported shape from the API contract
// QueuedActionType - union 'MarkAsRead'|'Delete'
// UserNotificationActionType - numeric action type 0|1|2
// QueuedAction - pending action (MarkAsRead/Delete) to send on next sync
// NotificationsStore - file-backed class with BehaviorSubject, mark methods, action queue, stamp, load/save
// END_MODULE_MAP

import { BehaviorSubject, Observable, map } from "rxjs";
import type { IFileStorage } from "../storage/vault-file-storage";

// START_BLOCK_TYPES
export interface NotificationRecord {
  notificationId: string;
  isDeleted?: boolean;
  message?: string;
  wasRead?: boolean;
  createdUtc?: Date;
}

export type QueuedActionType = "MarkAsRead" | "Delete";

export interface QueuedAction {
  notificationId: string;
  action: QueuedActionType;
}

export type UserNotificationActionType = 0 | 1 | 2; // Unknown=0, MarkAsRead=1, Delete=2

interface NotificationsFile {
  stamp: number;
  notifications: NotificationRecord[];
}
// END_BLOCK_TYPES

// START_CONTRACT: NotificationsStore
// PURPOSE: file-backed notifications store with reactive subject; stamp + notifications persisted to a dedicated JSON file
// INPUTS: deps: { storage: IFileStorage, path: string }
// OUTPUTS: notifications$ Observable, unreadCount$ Observable, stamp get/set, load/save
// SIDE_EFFECTS: read/write notifications JSON file via storage
// LINKS: UC-022, V-M-NOTIFICATIONS
// END_CONTRACT: NotificationsStore
export class NotificationsStore {
  private readonly _notifications$ = new BehaviorSubject<NotificationRecord[]>([]);
  private readonly _queuedActions: QueuedAction[] = [];
  private readonly _storage: IFileStorage;
  private readonly _path: string;
  private _stamp = 0;

  constructor(deps: { storage: IFileStorage; path: string }) {
    this._storage = deps.storage;
    this._path = deps.path;
  }

  get stamp(): number {
    return this._stamp;
  }

  set stamp(v: number) {
    this._stamp = v;
  }

  // START_BLOCK_PERSIST
  async load(): Promise<void> {
    try {
      const exists = await this._storage.exists(this._path);
      if (!exists) return;
      const raw = await this._storage.read(this._path);
      const data: NotificationsFile = JSON.parse(raw);
      this._stamp = typeof data.stamp === "number" ? data.stamp : 0;
      if (Array.isArray(data.notifications)) {
        const valid = data.notifications
          .filter(
            (n: unknown) => typeof (n as NotificationRecord)?.notificationId === "string",
          )
          .map((n: any) => ({
            ...n,
            createdUtc: n.createdUtc ? new Date(n.createdUtc) : undefined,
          }));
        this._notifications$.next(valid as NotificationRecord[]);
      }
    } catch {
      // Corrupted file or missing — start fresh.
    }
  }

  async save(): Promise<void> {
    try {
      const data: NotificationsFile = {
        stamp: this._stamp,
        notifications: this._notifications$.value,
      };
      await this._storage.write(this._path, JSON.stringify(data));
    } catch {
      // Silently fail — will retry on next sync cycle.
    }
  }
  // END_BLOCK_PERSIST

  // START_BLOCK_NOTIFICATIONS
  get notifications$(): Observable<NotificationRecord[]> {
    return this._notifications$.asObservable();
  }

  get unreadCount$(): Observable<number> {
    return this._notifications$.pipe(
      map((list) => list.filter((n) => !n.wasRead).length),
    );
  }

  getUnreadCount(): number {
    return this._notifications$.value.filter((n) => !n.wasRead).length;
  }

  getNotifications(): NotificationRecord[] {
    return this._notifications$.value;
  }

  setNotifications(records: NotificationRecord[]): void {
    this._notifications$.next(records);
  }
  // END_BLOCK_NOTIFICATIONS

  // START_BLOCK_ACTIONS
  markAsRead(id: string): void {
    const list = this._notifications$.value;
    const idx = list.findIndex((n) => n.notificationId === id);
    if (idx === -1 || list[idx]!.wasRead) return;
    const updated = list.map((n, i) =>
      i === idx ? { ...n, wasRead: true } : n,
    );
    this._notifications$.next(updated);
    if (!this._queuedActions.some((a) => a.notificationId === id)) {
      this._queuedActions.push({ notificationId: id, action: "MarkAsRead" });
    }
  }

  markAllAsRead(): void {
    const list = this._notifications$.value;
    const unread = list.filter((n) => !n.wasRead);
    if (unread.length === 0) return;
    const updated = list.map((n) => (n.wasRead ? n : { ...n, wasRead: true }));
    this._notifications$.next(updated);
    for (const n of unread) {
      if (!this._queuedActions.some((a) => a.notificationId === n.notificationId)) {
        this._queuedActions.push({ notificationId: n.notificationId, action: "MarkAsRead" });
      }
    }
  }

  /** Drains and returns queued actions. Call only after successful sync. */
  drainQueuedActions(): QueuedAction[] {
    return this._queuedActions.splice(0);
  }

  hasQueuedActions(): boolean {
    return this._queuedActions.length > 0;
  }
  // END_BLOCK_ACTIONS
}

// START_CHANGE_SUMMARY
// LAST_CHANGE: 2026-05-27 — initial M-NOTIFICATIONS store
// LAST_CHANGE: 2026-06-07 — switch to file-backed persistence (IFileStorage): stamp + notifications saved to separate JSON file; validate notificationId on load
// LAST_CHANGE: 2026-06-07 — fix JSON deserialization: convert createdUtc string → Date on load, preventing crash in settings UI when rendering after restart
// END_CHANGE_SUMMARY
