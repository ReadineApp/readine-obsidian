// START_MODULE_CONTRACT
// PURPOSE: Pure path-conflict resolver for UC-014. Stable feedItemId→path mapping ensures idempotence across re-syncs.
// SCOPE: src/vault/conflict-resolver.ts
// DEPENDS: none
// LINKS: UC-014, V-M-CONFLICT-RESOLVER
// ROLE: RUNTIME
// MAP_MODE: EXPORTS
// END_MODULE_CONTRACT

// START_MODULE_MAP
// resolvePath - resolve a path conflict via articleId-derived suffix; idempotent for same articleId
// appendSuffixBeforeExt - helper: inject suffix before file extension (foo.md + -abc → foo-abc.md)
// END_MODULE_MAP

// START_BLOCK_INTERNAL_LOG
function logInfo(
  anchor: string,
  event: string,
  belief: string,
  details: Record<string, unknown> = {},
): void {
  // eslint-disable-next-line no-console
  console.debug({
    ts: new Date().toISOString(),
    level: "info",
    anchor,
    module: "M-CONFLICT-RESOLVER",
    requirement: "UC-014",
    event,
    belief,
    ...details,
  });
}
// END_BLOCK_INTERNAL_LOG

// START_CONTRACT: appendSuffixBeforeExt
// PURPOSE: inject a suffix before the file extension; if no extension, append at the end
// INPUTS: path: string, suffix: string
// OUTPUTS: string — path with suffix inserted (e.g. "foo.md" + "-abc12345" → "foo-abc12345.md")
// SIDE_EFFECTS: none
// LINKS: UC-014, V-M-CONFLICT-RESOLVER
// END_CONTRACT: appendSuffixBeforeExt
export function appendSuffixBeforeExt(path: string, suffix: string): string {
  // START_BLOCK_FIND_EXT
  const lastSlash = path.lastIndexOf("/");
  const lastDot = path.lastIndexOf(".");
  // Only treat the trailing dot as an extension separator if it lives in the
  // final segment (after the last slash) — otherwise dots in directory names
  // would split incorrectly.
  if (lastDot === -1 || lastDot < lastSlash || lastDot === path.length - 1) {
    return path + suffix;
  }
  // END_BLOCK_FIND_EXT

  // START_BLOCK_SPLICE
  const base = path.slice(0, lastDot);
  const ext = path.slice(lastDot);
  return base + suffix + ext;
  // END_BLOCK_SPLICE
}

// START_CONTRACT: resolvePath
// PURPOSE: resolve a candidate vault path against a feedItemId→path mapping
// INPUTS: intendedPath: string, feedItemId: string, mappings: Record<string, string>
// OUTPUTS: { finalPath: string; mappingsUpdate: Record<string, string> } — finalPath is collision-free; mappingsUpdate is the (possibly empty) delta the caller must persist
// SIDE_EFFECTS: emits PATH_RESOLVED / CONFLICT_SUFFIX_APPLIED log events
// LINKS: UC-014, V-M-CONFLICT-RESOLVER
// END_CONTRACT: resolvePath
export function resolvePath(
  intendedPath: string,
  feedItemId: string,
  mappings: Record<string, string>,
): { finalPath: string; mappingsUpdate: Record<string, string> } {
  // START_BLOCK_IDEMPOTENT_LOOKUP
  // Step 1: if we already remembered a path for this feedItemId AND the
  // intendedPath matches, return it as-is.  This preserves idempotence —
  // re-running sync must not invent new suffixes.
  //
  // When the intendedPath diverges (path template changed or article data
  // changed), we MUST fall through to re-resolve with the new intendedPath.
  // Returning the old mapping unconditionally would force articles back to
  // stale paths after a template change (UC-014 regression).
  const existing = mappings[feedItemId];
  if (typeof existing === "string" && existing.length > 0) {
    if (existing === intendedPath) {
      logInfo(
        "resolvePath:BLOCK_IDEMPOTENT_LOOKUP",
        "PATH_RESOLVED",
        "stable mapping reused for feedItemId (intendedPath unchanged)",
        { feedItemId, finalPath: existing },
      );
      return { finalPath: existing, mappingsUpdate: {} };
    }
    logInfo(
      "resolvePath:BLOCK_IDEMPOTENT_LOOKUP",
      "PATH_DIVERGED",
      "intendedPath differs from existing mapping — re-resolving",
      { feedItemId, intendedPath, existing },
    );
  }
  // END_BLOCK_IDEMPOTENT_LOOKUP

  // START_BLOCK_CHECK_OCCUPATION
  // Step 2: detect whether some OTHER article already owns the intended path.
  let occupied = false;
  for (const ownerId of Object.keys(mappings)) {
    if (ownerId === feedItemId) continue;
    if (mappings[ownerId] === intendedPath) {
      occupied = true;
      break;
    }
  }
  if (!occupied) {
    logInfo(
      "resolvePath:BLOCK_CHECK_OCCUPATION",
      "PATH_RESOLVED",
      "intended path free, claimed by feedItemId",
      { feedItemId, finalPath: intendedPath },
    );
    return {
      finalPath: intendedPath,
      mappingsUpdate: { [feedItemId]: intendedPath },
    };
  }
  // END_BLOCK_CHECK_OCCUPATION

  // START_BLOCK_APPLY_SUFFIX
  // Step 3: conflict. Append `-{feedItemId.slice(0,8)}` before the extension.
  const suffix = `-${feedItemId.slice(0, 8)}`;
  const finalPath = appendSuffixBeforeExt(intendedPath, suffix);
  logInfo(
    "resolvePath:BLOCK_APPLY_SUFFIX",
    "CONFLICT_SUFFIX_APPLIED",
    "intended path occupied by other feedItemId; appended suffix",
    {
      feedItemId,
      intendedPath,
      finalPath,
      suffix,
    },
  );
  return {
    finalPath,
    mappingsUpdate: { [feedItemId]: finalPath },
  };
  // END_BLOCK_APPLY_SUFFIX
}

// START_CHANGE_SUMMARY
// LAST_CHANGE: 2026-06-08 — migrate resolvePath key from articleId to feedItemId (UC-016 fix: deletes with null articleId could not find pathMappings entry)
// END_CHANGE_SUMMARY
