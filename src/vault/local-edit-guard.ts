// START_MODULE_CONTRACT
// PURPOSE: Pure mtime guard protecting user's local edits (UC-013). Critical invariant: ни одна перезапись без этой проверки.
// SCOPE: src/vault/local-edit-guard.ts
// DEPENDS: none
// LINKS: UC-013, V-M-LOCAL-EDIT-GUARD
// ROLE: RUNTIME
// MAP_MODE: EXPORTS
// END_MODULE_CONTRACT

// START_MODULE_MAP
// shouldSkipOverwrite - pure boolean: localMtime > lastSyncWriteMtime → skip
// END_MODULE_MAP

// START_BLOCK_INTERNAL_LOG
function logInfo(
  anchor: string,
  event: string,
  belief: string,
  details: Record<string, unknown> = {},
): void {
  console.debug({
    ts: new Date().toISOString(),
    level: "info",
    anchor,
    module: "M-LOCAL-EDIT-GUARD",
    requirement: "UC-013",
    event,
    belief,
    ...details,
  });
}
// END_BLOCK_INTERNAL_LOG

// START_CONTRACT: shouldSkipOverwrite
// PURPOSE: decide whether sync should skip overwriting a vault file
// INPUTS: localMtimeMs: number (vault.stat.mtime), lastSyncWriteMtimeMs: number (ArticleRegistry.lastSyncWriteMtime)
// OUTPUTS: boolean — true ⇒ skip overwrite (user touched the file after last sync)
// SIDE_EFFECTS: emits LOCAL_EDIT_GUARD_CHECK info log (belief: 'localMtime > lastSync')
// LINKS: UC-013, V-M-LOCAL-EDIT-GUARD
// END_CONTRACT: shouldSkipOverwrite
export function shouldSkipOverwrite(
  localMtimeMs: number,
  lastSyncWriteMtimeMs: number,
): boolean {
  // START_BLOCK_COMPARE
  // Strict > so that equality (==) returns false — sync itself wrote the file,
  // so the file's mtime matches lastSyncWriteMtime exactly.
  const skip = localMtimeMs > lastSyncWriteMtimeMs;
  // END_BLOCK_COMPARE

  // START_BLOCK_EMIT
  logInfo(
    "shouldSkipOverwrite",
    "LOCAL_EDIT_GUARD_CHECK",
    "localMtime > lastSync",
    {
      localMtimeMs,
      lastSyncWriteMtimeMs,
      skip,
    },
  );
  return skip;
  // END_BLOCK_EMIT
}

// START_CHANGE_SUMMARY
// LAST_CHANGE: 2026-05-13 — initial pure implementation per Phase 2B M-LOCAL-EDIT-GUARD
// END_CHANGE_SUMMARY
