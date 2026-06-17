// START_MODULE_CONTRACT
// PURPOSE: Unit tests for M-VAULT-FILE-STORAGE — delegation + round-trip via in-memory MockDataAdapter.
// SCOPE: src/storage/vault-file-storage.test.ts
// DEPENDS: M-VAULT-FILE-STORAGE
// LINKS: V-M-VAULT-FILE-STORAGE
// ROLE: TEST
// END_MODULE_CONTRACT

// START_MODULE_MAP
// (test file — no public exports)
// END_MODULE_MAP

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => import("../__mocks__/obsidian"));

import { MockDataAdapter, __resetObsidianMock } from "../__mocks__/obsidian";
import type { DataAdapter } from "obsidian";
import { VaultFileStorage } from "./vault-file-storage";

/** Cast helper: MockDataAdapter implements only the subset of DataAdapter we need. */
function asAdapter(a: MockDataAdapter): DataAdapter {
  return a as unknown as DataAdapter;
}

describe("M-VAULT-FILE-STORAGE (V-M-VAULT-FILE-STORAGE)", () => {
  let adapter: MockDataAdapter;
  let storage: VaultFileStorage;

  beforeEach(() => {
    __resetObsidianMock();
    adapter = new MockDataAdapter();
    storage = new VaultFileStorage(asAdapter(adapter));
  });

  // scenario-1: read/write/exists/remove/stat delegate to vault.adapter
  describe("scenario-1: delegation to vault.adapter", () => {
    it("write delegates to adapter.write for strings", async () => {
      const spy = vi.spyOn(adapter, "write");
      await storage.write("notes/a.md", "hello");
      expect(spy).toHaveBeenCalledWith("notes/a.md", "hello");
    });

    it("write delegates to adapter.writeBinary for ArrayBuffer", async () => {
      const spy = vi.spyOn(adapter, "writeBinary");
      const buf = new TextEncoder().encode("bin").buffer as ArrayBuffer;
      await storage.write("data/x.bin", buf);
      expect(spy).toHaveBeenCalledWith("data/x.bin", buf);
    });

    it("read delegates to adapter.read", async () => {
      await adapter.write("a.md", "hi");
      const spy = vi.spyOn(adapter, "read");
      const got = await storage.read("a.md");
      expect(spy).toHaveBeenCalledWith("a.md");
      expect(got).toBe("hi");
    });

    it("exists delegates and returns boolean", async () => {
      await adapter.write("b.md", "x");
      expect(await storage.exists("b.md")).toBe(true);
      expect(await storage.exists("nope.md")).toBe(false);
    });

    it("remove delegates and disappears the file", async () => {
      await adapter.write("c.md", "x");
      await storage.remove("c.md");
      expect(await storage.exists("c.md")).toBe(false);
    });

    it("stat returns { mtime, size } or null", async () => {
      await adapter.write("d.md", "abcd");
      const s = await storage.stat("d.md");
      expect(s).not.toBeNull();
      expect(s?.size).toBe(4);
      expect(typeof s?.mtime).toBe("number");
      expect(await storage.stat("missing.md")).toBeNull();
    });

    it("list returns flattened files+folders", async () => {
      await adapter.mkdir("dir");
      await adapter.write("dir/a.md", "1");
      await adapter.write("dir/b.md", "2");
      const flat = await storage.list("dir");
      expect(flat).toEqual(expect.arrayContaining(["a.md", "b.md"]));
    });

    it("mkdir delegates to adapter.mkdir", async () => {
      const spy = vi.spyOn(adapter, "mkdir");
      await storage.mkdir("new-dir");
      expect(spy).toHaveBeenCalledWith("new-dir");
    });

    it("readBinary delegates to adapter.readBinary", async () => {
      const buf = new TextEncoder().encode("xyz").buffer as ArrayBuffer;
      await adapter.writeBinary("bin.dat", buf);
      const out = await storage.readBinary("bin.dat");
      expect(out.byteLength).toBe(3);
    });
  });

  // scenario-2: integration — round-trip write→read via in-memory mock
  describe("scenario-2: round-trip integration", () => {
    it("writes a string then reads it back unchanged", async () => {
      const payload = "# Article\n\nBody with **bold** and `code`.";
      await storage.write("articles/hello.md", payload);
      const got = await storage.read("articles/hello.md");
      expect(got).toBe(payload);
    });

    it("stat after write reports non-zero mtime and correct size", async () => {
      await storage.write("articles/sized.md", "12345");
      const s = await storage.stat("articles/sized.md");
      expect(s?.size).toBe(5);
      expect(s?.mtime).toBeGreaterThan(0);
    });

    it("writes to a deeply nested path without prior mkdir", async () => {
      const deepPath = "f1/f1-2/2026/06/07/title.md";
      await storage.write(deepPath, "deep content");
      const got = await storage.read(deepPath);
      expect(got).toBe("deep content");
    });

    it("constructor accepts a Vault-like object with .adapter", async () => {
      const vaultLike = { adapter } as unknown as { adapter: DataAdapter };
      const s = new VaultFileStorage(vaultLike as unknown as DataAdapter);
      await s.write("from-vault.md", "ok");
      expect(await s.read("from-vault.md")).toBe("ok");
    });

    it("propagates adapter errors and emits a warn log", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      await expect(storage.read("does-not-exist.md")).rejects.toThrow();
      expect(warnSpy).toHaveBeenCalled();
      const payload = warnSpy.mock.calls[0]?.[0] as { event?: string } | undefined;
      expect(payload?.event).toBe("VAULT_OP_FAILED");
      warnSpy.mockRestore();
    });
  });
});

// START_CHANGE_SUMMARY
// LAST_CHANGE: 2026-06-07 — add test for deep nested write without prior mkdir
// END_CHANGE_SUMMARY
