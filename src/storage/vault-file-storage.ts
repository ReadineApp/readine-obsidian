// START_MODULE_CONTRACT
// PURPOSE: IFileStorage interface + VaultFileStorage adapter over Obsidian vault.adapter (read/write/exists/remove/stat/list/mkdir). Single seam through which all vault I/O passes.
// SCOPE: src/storage/vault-file-storage.ts
// DEPENDS: M-PLATFORM
// LINKS: UC-003, UC-007, UC-013, UC-016, UC-017, V-M-VAULT-FILE-STORAGE
// ROLE: RUNTIME
// MAP_MODE: EXPORTS
// END_MODULE_CONTRACT

// START_MODULE_MAP
// IFileStorage - vault file I/O contract (read, readBinary, write, exists, remove, stat, list, mkdir, resetMkdirCache)
// FileStat - typed stat result (mtime ms + byte size)
// VaultFileStorage - class implementing IFileStorage over an Obsidian DataAdapter
// END_MODULE_MAP

import type { DataAdapter, Vault } from "obsidian";

// START_BLOCK_TYPES
export interface FileStat {
  /** Last modification time in milliseconds since the Unix epoch. */
  mtime: number;
  /** Size on disk in bytes. */
  size: number;
}

export interface IFileStorage {
  read(path: string): Promise<string>;
  readBinary(path: string): Promise<ArrayBuffer>;
  write(path: string, content: string | ArrayBuffer): Promise<void>;
  exists(path: string): Promise<boolean>;
  remove(path: string): Promise<void>;
  stat(path: string): Promise<FileStat | null>;
  list(path: string): Promise<string[]>;
  mkdir(path: string): Promise<void>;
  resetMkdirCache(): void;
}
// END_BLOCK_TYPES

// START_BLOCK_INTERNAL_LOG
function logWarn(
  anchor: string,
  event: string,
  belief: string,
  details: Record<string, unknown> = {},
): void {
  console.warn({
    ts: new Date().toISOString(),
    level: "warn",
    anchor,
    module: "M-VAULT-FILE-STORAGE",
    requirement: "UC-003",
    event,
    belief,
    ...details,
  });
}
// END_BLOCK_INTERNAL_LOG

// START_BLOCK_ADAPTER_RESOLVE
/**
 * Accept either a full Obsidian `Vault` (in which case we read `vault.adapter`)
 * or a bare `DataAdapter`. The plugin entry point typically passes the Vault,
 * while tests pass a `MockDataAdapter` directly.
 */
function resolveAdapter(target: Vault | DataAdapter): DataAdapter {
  // Vault exposes `.adapter`; DataAdapter does not — duck-type on that.
  const maybeVault = target as { adapter?: DataAdapter };
  if (maybeVault.adapter && typeof maybeVault.adapter.read === "function") {
    return maybeVault.adapter;
  }
  return target as DataAdapter;
}
// END_BLOCK_ADAPTER_RESOLVE

// START_CONTRACT: VaultFileStorage
// PURPOSE: IFileStorage implementation delegating to Obsidian's DataAdapter
// INPUTS: target — Vault or DataAdapter (DI seam)
// OUTPUTS: class instance with 8 async methods
// SIDE_EFFECTS: forwards to vault.adapter; emits VAULT_OP_FAILED warn on adapter exceptions
// LINKS: UC-003, V-M-VAULT-FILE-STORAGE
// END_CONTRACT: VaultFileStorage
export class VaultFileStorage implements IFileStorage {
  private readonly adapter: DataAdapter;
  private _createdDirs = new Set<string>();

  constructor(target: Vault | DataAdapter) {
    this.adapter = resolveAdapter(target);
  }

  resetMkdirCache(): void {
    this._createdDirs.clear();
  }

  // START_BLOCK_READ
  async read(path: string): Promise<string> {
    try {
      return await this.adapter.read(path);
    } catch (err) {
      logWarn("VaultFileStorage.read", "VAULT_OP_FAILED", "adapter.read threw", {
        path,
        error: String(err),
      });
      throw err;
    }
  }

  async readBinary(path: string): Promise<ArrayBuffer> {
    try {
      return await this.adapter.readBinary(path);
    } catch (err) {
      logWarn(
        "VaultFileStorage.readBinary",
        "VAULT_OP_FAILED",
        "adapter.readBinary threw",
        { path, error: String(err) },
      );
      throw err;
    }
  }
  // END_BLOCK_READ

  // START_BLOCK_WRITE
  async write(path: string, content: string | ArrayBuffer): Promise<void> {
    try {
      // Ensure parent directory exists before writing.
      // Obsidian API states adapter.write auto-creates parent dirs, but on some
      // platforms (Windows, custom vaults) the guarantee does not hold.
      // adapter.mkdir is recursive and idempotent — safe to call unconditionally.
      const parentDir = path.substring(0, path.lastIndexOf("/"));
      if (parentDir && !this._createdDirs.has(parentDir)) {
        await this.adapter.mkdir(parentDir);
        this._createdDirs.add(parentDir);
      }

      if (typeof content === "string") {
        await this.adapter.write(path, content);
      } else {
        await this.adapter.writeBinary(path, content);
      }
    } catch (err) {
      logWarn(
        "VaultFileStorage.write",
        "VAULT_OP_FAILED",
        "adapter.write/writeBinary threw",
        { path, error: String(err) },
      );
      throw err;
    }
  }
  // END_BLOCK_WRITE

  // START_BLOCK_PROBE
  async exists(path: string): Promise<boolean> {
    return this.adapter.exists(path);
  }

  async remove(path: string): Promise<void> {
    try {
      await this.adapter.remove(path);
    } catch (err) {
      logWarn(
        "VaultFileStorage.remove",
        "VAULT_OP_FAILED",
        "adapter.remove threw",
        { path, error: String(err) },
      );
      throw err;
    }
  }

  async stat(path: string): Promise<FileStat | null> {
    const raw = await this.adapter.stat(path);
    if (!raw) return null;
    return { mtime: raw.mtime, size: raw.size };
  }

  async list(path: string): Promise<string[]> {
    const listing = await this.adapter.list(path);
    // DataAdapter.list returns ListedFiles { files: string[]; folders: string[] }.
    // We flatten to a single list — callers can re-stat if they need the kind.
    return [...listing.files, ...listing.folders];
  }

  async mkdir(path: string): Promise<void> {
    try {
      await this.adapter.mkdir(path);
    } catch (err) {
      logWarn(
        "VaultFileStorage.mkdir",
        "VAULT_OP_FAILED",
        "adapter.mkdir threw",
        { path, error: String(err) },
      );
      throw err;
    }
  }
  // END_BLOCK_PROBE
}

// START_CHANGE_SUMMARY
// LAST_CHANGE: 2026-06-07 — add resetMkdirCache() + Set<string> dedup to skip redundant adapter.mkdir calls per batch
// END_CHANGE_SUMMARY
