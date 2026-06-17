// PURPOSE: Tests for M-NOTIFICATIONS — store, sync, and integration
// LINKS: V-M-NOTIFICATIONS

import { describe, it, expect, vi, beforeEach } from "vitest";
vi.mock("obsidian", () => import("../__mocks__/obsidian"));
import { firstValueFrom, of, throwError } from "rxjs";
import { NotificationsStore } from "./notifications-store";
import { NotificationsSync } from "./notifications-sync";
import type { IFileStorage } from "../storage/vault-file-storage";

// ── Mock helpers ──────────────────────────────────────────────────

function mockStorage(): IFileStorage & { _files: Map<string, string> } {
  const files = new Map<string, string>();
  return {
    _files: files,
    read: vi.fn(async (path: string) => {
      const content = files.get(path);
      if (content === undefined) throw new Error("ENOENT");
      return content;
    }),
    readBinary: vi.fn(async () => new ArrayBuffer(0)),
    write: vi.fn(async (path: string, content: string) => {
      files.set(path, content as string);
    }),
    resetMkdirCache: vi.fn(() => {}),
    exists: vi.fn(async (path: string) => files.has(path)),
    remove: vi.fn(async (path: string) => { files.delete(path); }),
    stat: vi.fn(async () => null),
    list: vi.fn(async () => []),
    mkdir: vi.fn(async () => {}),
  } as unknown as IFileStorage & { _files: Map<string, string> };
}

function makeStore(storage?: IFileStorage): NotificationsStore {
  return new NotificationsStore({
    storage: storage ?? mockStorage(),
    path: ".obsidian/test/notifications.json",
  });
}

// ── scenario-1: store.setNotifications ────────────────────────────

describe("NotificationsStore", () => {
  it("scenario-1: setNotifications replaces in-memory list", () => {
    const store = makeStore();
    expect(store.getNotifications()).toEqual([]);

    store.setNotifications([
      { notificationId: "n1", message: "Hello", wasRead: false },
    ]);
    expect(store.getNotifications()).toHaveLength(1);
    expect(store.getNotifications()[0]!.notificationId).toBe("n1");
  });

  it("scenario-2: unreadCount$ emits correct count", async () => {
    const store = makeStore();
    store.setNotifications([
      { notificationId: "n1", message: "A", wasRead: false },
      { notificationId: "n2", message: "B", wasRead: true },
      { notificationId: "n3", message: "C", wasRead: false },
    ]);
    const count = await firstValueFrom(store.unreadCount$);
    expect(count).toBe(2);
  });

  it("scenario-3: markAsRead updates wasRead and recalculates count", async () => {
    const store = makeStore();
    store.setNotifications([
      { notificationId: "n1", message: "A", wasRead: false },
      { notificationId: "n2", message: "B", wasRead: false },
    ]);
    store.markAsRead("n1");
    const list = store.getNotifications();
    expect(list.find((n) => n.notificationId === "n1")?.wasRead).toBe(true);
    expect(list.find((n) => n.notificationId === "n2")?.wasRead).toBe(false);
    // Action queued
    expect(store.drainQueuedActions()).toHaveLength(1);
  });

  it("scenario-4: markAllAsRead updates all unread", () => {
    const store = makeStore();
    store.setNotifications([
      { notificationId: "n1", message: "A", wasRead: false },
      { notificationId: "n2", message: "B", wasRead: true },
    ]);
    store.markAllAsRead();
    const list = store.getNotifications();
    expect(list.every((n) => n.wasRead)).toBe(true);
    // Only n1 was unread — one action queued
    expect(store.drainQueuedActions()).toHaveLength(1);
  });

  it("drainQueuedActions returns and clears the queue", () => {
    const store = makeStore();
    store.setNotifications([
      { notificationId: "n1", message: "A", wasRead: false },
    ]);
    store.markAsRead("n1");
    expect(store.hasQueuedActions()).toBe(true);
    const actions = store.drainQueuedActions();
    expect(actions).toHaveLength(1);
    expect(store.hasQueuedActions()).toBe(false);
  });

  it("duplicate markAsRead does not double-queue", () => {
    const store = makeStore();
    store.setNotifications([
      { notificationId: "n1", message: "A", wasRead: false },
    ]);
    store.markAsRead("n1");
    store.markAsRead("n1"); // already read — no-op
    expect(store.drainQueuedActions()).toHaveLength(1);
  });

  // ── File persistence tests ──────────────────────────────────────

  it("load: returns empty state when file does not exist", async () => {
    const storage = mockStorage();
    const store = new NotificationsStore({ storage, path: ".obsidian/test/nf.json" });
    await store.load();
    expect(store.stamp).toBe(0);
    expect(store.getNotifications()).toEqual([]);
  });

  it("save + load round-trips stamp and notifications", async () => {
    const storage = mockStorage();
    const store = new NotificationsStore({ storage, path: ".obsidian/test/nf.json" });
    store.stamp = 12345;
    store.setNotifications([
      { notificationId: "n1", message: "Hello", wasRead: false },
    ]);
    await store.save();

    const store2 = new NotificationsStore({ storage, path: ".obsidian/test/nf.json" });
    await store2.load();
    expect(store2.stamp).toBe(12345);
    expect(store2.getNotifications()).toHaveLength(1);
    expect(store2.getNotifications()[0]!.notificationId).toBe("n1");
  });

  it("load: filters out records without notificationId", async () => {
    const storage = mockStorage();
    // Write corrupted data directly
    await storage.write(".obsidian/test/nf.json", JSON.stringify({
      stamp: 99,
      notifications: [
        { notificationId: "ok", message: "good" },
        { message: "bad — no id" },
        { notificationId: "ok2", message: "good2" },
        null,
      ],
    }));
    const store = new NotificationsStore({ storage, path: ".obsidian/test/nf.json" });
    await store.load();
    expect(store.getNotifications()).toHaveLength(2);
    expect(store.getNotifications()[0]!.notificationId).toBe("ok");
    expect(store.getNotifications()[1]!.notificationId).toBe("ok2");
  });

  it("load: survives corrupted JSON gracefully", async () => {
    const storage = mockStorage();
    await storage.write(".obsidian/test/nf.json", "not valid json{{{");
    const store = new NotificationsStore({ storage, path: ".obsidian/test/nf.json" });
    await store.load();
    expect(store.stamp).toBe(0);
    expect(store.getNotifications()).toEqual([]);
  });
});

// ── scenario-5: sync API call ─────────────────────────────────────

describe("NotificationsSync", () => {
  it("scenario-5: sync fetches delta via apiNotificationsSync, updates store + stamp", async () => {
    const storage = mockStorage();
    const store = new NotificationsStore({ storage, path: ".obsidian/test/ns.json" });
    store.stamp = 100;
    const apiClient = {
      apiNotificationsSync: vi.fn(() =>
        of({
          syncStamp: 200,
          notifications: [
            { notificationId: "n1", message: "New!", wasRead: false, createdUtc: "2026-05-27T00:00:00Z" },
          ],
        }),
      ),
    };

    const sync = new NotificationsSync({ store, apiClient, pluginVersion: "0.1.0" });
    await firstValueFrom(sync.sync());

    // Stamp updated on store
    expect(store.stamp).toBe(200);
    // Store updated
    expect(store.getNotifications()).toHaveLength(1);
    expect(store.getNotifications()[0]!.message).toBe("New!");
    // File was persisted
    expect(storage.write).toHaveBeenCalled();
  });

  it("scenario-6: actions queued after markAsRead sent on next sync", async () => {
    const storage = mockStorage();
    const store = new NotificationsStore({ storage, path: ".obsidian/test/ns.json" });
    const apiClient = {
      apiNotificationsSync: vi.fn(() => of({ syncStamp: 300, notifications: [] })),
    };

    // Queue an action
    store.setNotifications([
      { notificationId: "n1", message: "A", wasRead: false },
    ]);
    store.markAsRead("n1");

    const sync = new NotificationsSync({ store, apiClient, pluginVersion: "0.1.0" });
    await firstValueFrom(sync.sync());

    // The API was called with the action in the body
    expect(apiClient.apiNotificationsSync).toHaveBeenCalled();
    const spy = apiClient.apiNotificationsSync as unknown as { mock: { calls: Array<Array<unknown>> } };
    const callArg = spy.mock.calls[0]?.[0] as Record<string, unknown>;
    const actions = callArg?.actions as Array<Record<string, unknown>> | undefined;
    expect(actions).toHaveLength(1);
    expect(actions![0]!.notificationId).toBe("n1");
    expect(actions![0]!.action).toBe(1); // MarkAsRead
    // Queue drained
    expect(store.hasQueuedActions()).toBe(false);
  });

  it("scenario-7 (integration): error in sync does not throw — returns gracefully", async () => {
    const storage = mockStorage();
    const store = new NotificationsStore({ storage, path: ".obsidian/test/ns.json" });
    const apiClient = {
      apiNotificationsSync: vi.fn(() => throwError(() => new Error("network down"))),
    };

    const sync = new NotificationsSync({ store, apiClient, pluginVersion: "0.1.0" });
    // Should not throw
    const result = await firstValueFrom(sync.sync());
    expect(result).toBeUndefined();
    // Store unchanged
    expect(store.getNotifications()).toEqual([]);
  }, 20000);
});
