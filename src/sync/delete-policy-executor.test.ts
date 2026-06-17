// START_MODULE_CONTRACT
// PURPOSE: Tests for M-DELETE-POLICY-EXECUTOR — keep (no-op), delete with mtime-guard fallback, missing-file no-op, and integration cycle exercising keep/delete against a single mock vault.
// SCOPE: src/sync/delete-policy-executor.test.ts
// DEPENDS: M-DELETE-POLICY-EXECUTOR, M-VAULT-FILE-STORAGE, M-FRONTMATTER-CODEC, M-SETTINGS-MANAGER
// LINKS: V-M-DELETE-POLICY-EXECUTOR
// ROLE: TEST
// END_MODULE_CONTRACT

// START_MODULE_MAP
// (test file — no public exports)
// END_MODULE_MAP

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => import("../__mocks__/obsidian"));

import { MockDataAdapter, __resetObsidianMock } from "../__mocks__/obsidian";
import type { DataAdapter } from "obsidian";
import { VaultFileStorage } from "../storage/vault-file-storage";
import { SettingsManager } from "../settings/settings-manager";
import { getDefaults } from "../settings/settings-defaults";

import { DeletePolicyExecutor } from "./delete-policy-executor";

function asAdapter(a: MockDataAdapter): DataAdapter {
  return a as unknown as DataAdapter;
}

async function makeSettings(): Promise<SettingsManager> {
  let store: object | null = null;
  const plugin = {
    saveData: async (data: object) => {
      store = data;
    },
    loadData: async () => store,
  };
  const m = new SettingsManager(plugin, getDefaults("desktop"));
  await m.init();
  return m;
}

function buildArticleFile(
  meta: { articleId: string; title?: string; source?: string; url?: string; date?: string; tags?: string[] },
  body = "Body text\n",
): string {
  return `---
title: ${meta.title ?? `Title ${meta.articleId}`}
source: ${meta.source ?? "Readine"}
url: ${meta.url ?? "https://example.com/x"}
date: ${meta.date ?? "2026-05-13T00:00:00Z"}
tags: [${(meta.tags ?? ["tech"]).join(", ")}]
articleId: ${meta.articleId}
---
${body}`;
}

describe("M-DELETE-POLICY-EXECUTOR (V-M-DELETE-POLICY-EXECUTOR)", () => {
  let adapter: MockDataAdapter;
  let storage: VaultFileStorage;

  beforeEach(() => {
    __resetObsidianMock();
    adapter = new MockDataAdapter();
    storage = new VaultFileStorage(asAdapter(adapter));
  });

  // -------------------------------------------------------------------------
  // scenario-1 — keep
  // -------------------------------------------------------------------------
  it("scenario-1: keep → file untouched (no frontmatter modification)", async () => {
    const settings = await makeSettings();
    const finalPath = "Readine/MyFeed/2026-05/Hello.md";
    const original = buildArticleFile({ articleId: "a-1" }, "Hello body\n");
    await adapter.write(finalPath, original);

    const exec = new DeletePolicyExecutor({ storage, settings });
    const infoSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});

    const result = await exec.apply({ id: "a-1", finalPath }, "keep");
    expect(result).toEqual({ action: "kept" });
    expect(await storage.exists(finalPath)).toBe(true);
    const content = await storage.read(finalPath);
    expect(content).toBe(original);
    const events = infoSpy.mock.calls
      .map((c) => c[0] as Record<string, unknown>)
      .map((p) => p.event);
    expect(events).toContain("POLICY_APPLIED");
    infoSpy.mockRestore();
  });

  // -------------------------------------------------------------------------
  // scenario-2 — delete (clean path)
  // -------------------------------------------------------------------------
    it("scenario-2: delete → removes file when localMtime <= lastSyncWriteMtime", async () => {
    const settings = await makeSettings();
    const finalPath = "Readine/MyFeed/2026-05/Hello.md";
    const lastSync = 1_000_500;
    await adapter.write(
      finalPath,
      buildArticleFile({ articleId: "a-3" }, "doomed\n"),
    );
    adapter.__setMtime(finalPath, lastSync);

    const exec = new DeletePolicyExecutor({ storage, settings });
    const result = await exec.apply({ id: "a-3", finalPath, lastSyncWriteMtime: lastSync }, "delete");
    expect(result).toEqual({ action: "deleted" });
    expect(await storage.exists(finalPath)).toBe(false);
  });

  // -------------------------------------------------------------------------
  // scenario-3 — delete with mtime-guard fallback (CRITICAL invariant)
  // -------------------------------------------------------------------------
  it("scenario-3: delete + localMtime > lastSyncWriteMtime → fallback to keep (action='guarded')", async () => {
    const settings = await makeSettings();
    const finalPath = "Readine/MyFeed/2026-05/Hello.md";
    const lastSync = 1_000_500;
    await adapter.write(
      finalPath,
      buildArticleFile({ articleId: "a-4" }, "user-edited\n"),
    );
    // Simulate user edit by bumping mtime past lastSyncWriteMtime.
    adapter.__setMtime(finalPath, lastSync + 9000);

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const exec = new DeletePolicyExecutor({ storage, settings });

    const result = await exec.apply({ id: "a-4", finalPath, lastSyncWriteMtime: lastSync }, "delete");
    expect(result.action).toBe("guarded");
    // File MUST still exist — data-integrity invariant.
    expect(await storage.exists(finalPath)).toBe(true);
    const content = await storage.read(finalPath);
    // Body preserved, frontmatter unchanged (keep = no-op)
    expect(content).toMatch(/user-edited/);
    // DELETE_GUARDED marker emitted.
    const events = warnSpy.mock.calls
      .map((c) => c[0] as Record<string, unknown>)
      .map((p) => p.event);
    expect(events).toContain("DELETE_GUARDED");
    warnSpy.mockRestore();
  });

  // -------------------------------------------------------------------------
  // scenario-4 — integration: keep + delete cycle with mock vault
  // -------------------------------------------------------------------------
  it("scenario-4: integration — keep / delete cycle over two articles", async () => {
    const settings = await makeSettings();
    const exec = new DeletePolicyExecutor({
      storage,
      settings,
      now: () => Date.UTC(2026, 5, 1, 0, 0, 0),
    });

    // Article 1 → keep
    const p1 = "Readine/F/2026-05/keep-it.md";
    await adapter.write(p1, buildArticleFile({ articleId: "k-1" }));
    // Article 2 → delete (clean)
    const p2 = "Readine/F/2026-05/delete-me.md";
    await adapter.write(p2, buildArticleFile({ articleId: "d-1" }));
    adapter.__setMtime(p2, 1_500_000);

    const [r1, r2] = await Promise.all([
      exec.apply({ id: "k-1", finalPath: p1 }, "keep"),
      exec.apply({ id: "d-1", finalPath: p2, lastSyncWriteMtime: 1_500_000 }, "delete"),
    ]);

    expect(r1).toEqual({ action: "kept" });
    expect(r2).toEqual({ action: "deleted" });

    expect(await storage.exists(p1)).toBe(true);
    expect(await storage.exists(p2)).toBe(false);

    // The keep file retained its body without frontmatter changes.
    const k = await storage.read(p1);
    expect(k).toMatch(/articleId: "?k-1"?/);
  });

  // -------------------------------------------------------------------------
  // edge — missing file
  // -------------------------------------------------------------------------
  it("edge: missing target file → action='kept' with reason='missing'", async () => {
    const settings = await makeSettings();
    const exec = new DeletePolicyExecutor({ storage, settings });
    const result = await exec.apply(
      { id: "nope", finalPath: "Readine/missing.md" },
      "delete",
    );
    expect(result).toEqual({ action: "kept", reason: "missing" });
  });

  // -------------------------------------------------------------------------
  // edge — delete already-deleted file (idempotent)
  // -------------------------------------------------------------------------
  it("edge: delete twice → second call is idempotent with reason='missing'", async () => {
    const settings = await makeSettings();
    const finalPath = "Readine/MyFeed/2026-05/twice.md";
    await adapter.write(
      finalPath,
      buildArticleFile({ articleId: "i-1" }, "body\n"),
    );
    adapter.__setMtime(finalPath, 1_000_500);

    const exec = new DeletePolicyExecutor({ storage, settings });

    const r1 = await exec.apply({ id: "i-1", finalPath, lastSyncWriteMtime: 1_000_500 }, "delete");
    expect(r1).toEqual({ action: "deleted" });
    expect(await storage.exists(finalPath)).toBe(false);

    const r2 = await exec.apply({ id: "i-1", finalPath }, "delete");
    expect(r2).toEqual({ action: "kept", reason: "missing" });
  });

  // -------------------------------------------------------------------------
  // marker — anchor & module on POLICY_APPLIED
  // -------------------------------------------------------------------------
  it("emits POLICY_APPLIED with anchor 'apply:BLOCK_BRANCH' and module M-DELETE-POLICY-EXECUTOR", async () => {
    const settings = await makeSettings();
    const finalPath = "Readine/log/probe.md";
    await adapter.write(finalPath, buildArticleFile({ articleId: "p-1" }));
    const exec = new DeletePolicyExecutor({ storage, settings });
    const infoSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    await exec.apply({ id: "p-1", finalPath }, "keep");
    const payloads = infoSpy.mock.calls.map((c) => c[0] as Record<string, unknown>);
    const applied = payloads.find((p) => p.event === "POLICY_APPLIED");
    expect(applied).toBeDefined();
    expect(applied!.module).toBe("M-DELETE-POLICY-EXECUTOR");
    expect(applied!.anchor).toBe("apply:BLOCK_BRANCH");
    infoSpy.mockRestore();
  });
});

// START_CHANGE_SUMMARY
// LAST_CHANGE: 2026-05-13 — initial test suite for V-M-DELETE-POLICY-EXECUTOR
// END_CHANGE_SUMMARY
