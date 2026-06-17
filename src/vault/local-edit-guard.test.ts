// START_MODULE_CONTRACT
// PURPOSE: Unit tests for M-LOCAL-EDIT-GUARD — exhaustive boolean truth table + log marker assertion.
// SCOPE: src/vault/local-edit-guard.test.ts
// DEPENDS: M-LOCAL-EDIT-GUARD
// LINKS: V-M-LOCAL-EDIT-GUARD
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
import { shouldSkipOverwrite } from "./local-edit-guard";

function asAdapter(a: MockDataAdapter): DataAdapter {
  return a as unknown as DataAdapter;
}

describe("M-LOCAL-EDIT-GUARD (V-M-LOCAL-EDIT-GUARD)", () => {
  beforeEach(() => {
    __resetObsidianMock();
  });

  // scenario-1: localMtime < lastSyncMtime → sync wins
  it("scenario-1: localMtime < lastSyncMtime → shouldSkip=false (sync wins)", () => {
    expect(shouldSkipOverwrite(1_000, 2_000)).toBe(false);
  });

  // scenario-2: localMtime > lastSyncMtime → local edit wins
  it("scenario-2: localMtime > lastSyncMtime → shouldSkip=true (local edit wins)", () => {
    expect(shouldSkipOverwrite(3_000, 2_000)).toBe(true);
  });

  // scenario-3: equality treated as sync-wrote-it
  it("scenario-3: localMtime == lastSyncMtime → shouldSkip=false (equality = sync wrote it)", () => {
    expect(shouldSkipOverwrite(2_500, 2_500)).toBe(false);
  });

  // scenario-4: full vault.adapter.stat → guard chain
  it("scenario-4: integration — stat from MockDataAdapter feeds guard correctly", async () => {
    const adapter = new MockDataAdapter();
    const storage = new VaultFileStorage(asAdapter(adapter));
    await storage.write("a.md", "first content");
    const firstStat = await storage.stat("a.md");
    expect(firstStat).not.toBeNull();
    const lastSync = firstStat!.mtime;

    // No external edits — mtime equals lastSync.
    expect(shouldSkipOverwrite(firstStat!.mtime, lastSync)).toBe(false);

    // Simulate a user edit by bumping mtime forward.
    adapter.__setMtime("a.md", lastSync + 5_000);
    const editedStat = await storage.stat("a.md");
    expect(shouldSkipOverwrite(editedStat!.mtime, lastSync)).toBe(true);
  });

  // marker-1 — LOCAL_EDIT_GUARD_CHECK is emitted with the canonical belief
  it("emits LOCAL_EDIT_GUARD_CHECK marker with belief 'localMtime > lastSync'", () => {
    const infoSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    shouldSkipOverwrite(3_000, 2_000);
    const payload = infoSpy.mock.calls.find(
      (call) => (call[0] as { event?: string })?.event === "LOCAL_EDIT_GUARD_CHECK",
    )?.[0] as { belief?: string; module?: string };
    expect(payload?.module).toBe("M-LOCAL-EDIT-GUARD");
    expect(payload?.belief).toBe("localMtime > lastSync");
    infoSpy.mockRestore();
  });

  // Truth-table coverage — defense-in-depth against accidental sign flip.
  it("truth-table: exhaustive sign comparison stays pure", () => {
    const cases: Array<[number, number, boolean]> = [
      [0, 0, false],
      [0, 1, false],
      [1, 0, true],
      [Number.MAX_SAFE_INTEGER, 0, true],
      [0, Number.MAX_SAFE_INTEGER, false],
    ];
    for (const [local, last, expected] of cases) {
      expect(shouldSkipOverwrite(local, last)).toBe(expected);
    }
  });
});

// START_CHANGE_SUMMARY
// LAST_CHANGE: 2026-05-13 — initial test suite for V-M-LOCAL-EDIT-GUARD
// END_CHANGE_SUMMARY
