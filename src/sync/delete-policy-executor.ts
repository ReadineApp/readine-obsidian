// START_MODULE_CONTRACT
// PURPOSE: Handle server-side article deletions per user policy (UC-007, UC-016). apply(article, policy) executes one of two branches: 'keep' is a no-op (local file untouched); 'delete' removes the file but only after mtime-guard (localMtime > lastSyncWriteMtime ⇒ fallback to 'keep' with action='guarded' — critical data-integrity invariant, never destroys local edits). Both branches are no-ops when the target file is missing (returns action='kept' with reason='missing'). Emits structured markers POLICY_APPLIED / DELETE_GUARDED for traceability.
// SCOPE: src/sync/delete-policy-executor.ts
// DEPENDS: M-VAULT-FILE-STORAGE, M-LOCAL-EDIT-GUARD, M-FRONTMATTER-CODEC, M-SETTINGS-MANAGER
// LINKS: UC-007, UC-016, V-M-DELETE-POLICY-EXECUTOR
// ROLE: RUNTIME
// MAP_MODE: EXPORTS
// END_MODULE_CONTRACT

// START_MODULE_MAP
// DeletePolicy - union 'keep' | 'delete'
// DeletePolicyApplyInput - minimal article-identity slice: { id, finalPath, lastSyncWriteMtime? }
// DeletePolicyApplyResult - { action, reason? } returned by apply()
// DeletePolicyExecutorDeps - DI bag: { storage, settings }
// DeletePolicyExecutor - class with apply(article, policy): Promise<result>
// END_MODULE_MAP

import { shouldSkipOverwrite } from "../vault/local-edit-guard";
import type { IFileStorage } from "../storage/vault-file-storage";
import type { SettingsManager } from "../settings/settings-manager";

// START_BLOCK_TYPES
/** Two-way policy mirroring SettingsSnapshot["deletePolicy"]. */
export type DeletePolicy = "keep" | "delete";

/**
 * Minimal article-identity slice consumed by apply(). We do not depend on the
 * full Article shape — the executor only needs the id (for logging), the
 * already-resolved finalPath (so we don't re-render the path template, which
 * would risk drift if pathMappings has shifted since the original write),
 * and optionally lastSyncWriteMtime from the ArticleRegistry (UC-016 fix:
 * DEFAULT_FILE_TEMPLATE does not include this field in frontmatter).
 */
export interface DeletePolicyApplyInput {
  id: string;
  finalPath: string;
  /** Sync-write mtime from ArticleRegistry entry. */
  lastSyncWriteMtime?: number;
}

export interface DeletePolicyApplyResult {
  action: "kept" | "deleted" | "guarded";
  reason?: string;
}

export interface DeletePolicyExecutorDeps {
  storage: IFileStorage;
  settings: SettingsManager;
  /** Override for `Date.now()` so tests can pin timestamps deterministically. */
  now?: () => number;
}
// END_BLOCK_TYPES

// START_BLOCK_INTERNAL_LOG
const MODULE_ID = "M-DELETE-POLICY-EXECUTOR";

function logInfo(
  anchor: string,
  event: string,
  belief: string,
  requirement: string,
  details: Record<string, unknown> = {},
): void {
  console.debug({
    ts: new Date().toISOString(),
    level: "info",
    anchor,
    module: MODULE_ID,
    requirement,
    event,
    belief,
    ...details,
  });
}

function logWarn(
  anchor: string,
  event: string,
  belief: string,
  requirement: string,
  details: Record<string, unknown> = {},
): void {
  console.warn({
    ts: new Date().toISOString(),
    level: "warn",
    anchor,
    module: MODULE_ID,
    requirement,
    event,
    belief,
    ...details,
  });
}
// END_BLOCK_INTERNAL_LOG

// START_CONTRACT: DeletePolicyExecutor
// PURPOSE: apply server-side delete decisions onto vault files per user-chosen policy
// INPUTS: deps: DeletePolicyExecutorDeps
// OUTPUTS: class with apply(article, policy)
// SIDE_EFFECTS: vault read/write/remove via storage; emits POLICY_APPLIED / DELETE_GUARDED logs
// LINKS: UC-007, UC-016, V-M-DELETE-POLICY-EXECUTOR
// END_CONTRACT: DeletePolicyExecutor
export class DeletePolicyExecutor {
  private readonly storage: IFileStorage;
  private readonly settings: SettingsManager;
  private readonly now: () => number;

  constructor(deps: DeletePolicyExecutorDeps) {
    this.storage = deps.storage;
    this.settings = deps.settings;
    this.now = deps.now ?? (() => Date.now());
  }

  // START_CONTRACT: apply
  // PURPOSE: execute the chosen policy on a single article's vault file
  // INPUTS: article: { id, finalPath }, policy: DeletePolicy
  // OUTPUTS: Promise<DeletePolicyApplyResult> — { action, reason? }
  // SIDE_EFFECTS: vault read/write/remove via storage; emits POLICY_APPLIED / DELETE_GUARDED
  // LINKS: UC-007, UC-016, V-M-DELETE-POLICY-EXECUTOR
  // END_CONTRACT: apply
  async apply(
    article: DeletePolicyApplyInput,
    policy: DeletePolicy,
  ): Promise<DeletePolicyApplyResult> {
    // START_BLOCK_BRANCH
    // Guard: if the file is missing, every branch is a no-op. Returning
    // action='kept' with reason='missing' keeps the contract simple — callers
    // do not need to special-case the missing-file path.
    const exists = await this.storage.exists(article.finalPath);
    if (!exists) {
      logInfo(
        "apply:BLOCK_BRANCH",
        "POLICY_APPLIED",
        "target file missing — no-op",
        "UC-016",
        { articleId: article.id, finalPath: article.finalPath, policy, action: "kept", reason: "missing" },
      );
      return { action: "kept", reason: "missing" };
    }

    switch (policy) {
      case "keep":
        return await this._applyKeep(article);
      case "delete":
        return await this._applyDelete(article);
      default: {
        // Exhaustiveness guard — TS widens `policy` to `never` here.
        const _exhaustive: never = policy;
        logWarn(
          "apply:BLOCK_BRANCH",
          "POLICY_UNKNOWN",
          "unknown policy — defaulting to keep",
          "UC-007",
          { articleId: article.id, policy: String(_exhaustive) },
        );
        return await this._applyKeep(article);
      }
    }
    // END_BLOCK_BRANCH
  }

  // START_BLOCK_KEEP
  private async _applyKeep(
    article: DeletePolicyApplyInput,
  ): Promise<DeletePolicyApplyResult> {
    logInfo(
      "apply:BLOCK_BRANCH",
      "POLICY_APPLIED",
      "keep — file left untouched (server-side deletion ignored)",
      "UC-007",
      { articleId: article.id, finalPath: article.finalPath, action: "kept" },
    );
    return { action: "kept" };
  }
  // END_BLOCK_KEEP

  // START_BLOCK_GUARD
  private async _applyDelete(
    article: DeletePolicyApplyInput,
  ): Promise<DeletePolicyApplyResult> {
    // mtime-guard: compare file system mtime against lastSyncWriteMtime
    // from the ArticleRegistry (passed by the caller).
    const stat = await this.storage.stat(article.finalPath);
    const localMtime = stat?.mtime ?? 0;
    const lastSyncMtime = article.lastSyncWriteMtime ?? 0;

    const guarded = shouldSkipOverwrite(localMtime, lastSyncMtime);
    if (guarded) {
      // Fallback to keep — the file is left untouched (user edits win).
      // Action='guarded' marks the explicit policy override for telemetry.
      const keepResult = await this._applyKeep(article);
      logWarn(
        "apply:BLOCK_GUARD",
        "DELETE_GUARDED",
        "localMtime exceeds lastSyncWriteMtime — falling back to keep",
        "UC-016",
        {
          articleId: article.id,
          finalPath: article.finalPath,
          localMtime,
          lastSyncMtime,
          action: "guarded",
        },
      );
      return { action: "guarded", reason: keepResult.reason ?? "local_edits" };
    }

    // No local edits — safe to remove.
    try {
      await this.storage.remove(article.finalPath);
    } catch (err) {
      logWarn(
        "apply:BLOCK_GUARD",
        "POLICY_APPLY_FAIL",
        "remove threw — file may still exist on disk",
        "UC-016",
        { articleId: article.id, finalPath: article.finalPath, error: err instanceof Error ? err.message : String(err) },
      );
      return { action: "kept", reason: "remove_failed" };
    }
    logInfo(
      "apply:BLOCK_BRANCH",
      "POLICY_APPLIED",
      "delete — file removed (mtime-guard passed)",
      "UC-016",
      { articleId: article.id, finalPath: article.finalPath, action: "deleted" },
    );
    return { action: "deleted" };
  }
  // END_BLOCK_GUARD
}

// START_CHANGE_SUMMARY
// LAST_CHANGE: 2026-06-08 — add lastSyncWriteMtime to DeletePolicyApplyInput; use registry mtime (not frontmatter) in mtime-guard (UC-016 fix: DEFAULT_FILE_TEMPLATE omits this field)
// END_CHANGE_SUMMARY
