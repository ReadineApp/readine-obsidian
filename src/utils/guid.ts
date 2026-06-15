// START_MODULE_CONTRACT
// PURPOSE: RFC 4122 v4-like UUID generation for API request correlation (clientRequestId)
// SCOPE: src/utils/guid.ts
// DEPENDS: none
// LINKS: UC-003, UC-022
// ROLE: RUNTIME
// MAP_MODE: EXPORTS
// END_MODULE_CONTRACT

// START_MODULE_MAP
// generateGuid - RFC 4122 v4-like UUID string
// END_MODULE_MAP

// START_CONTRACT: generateGuid
// PURPOSE: produce a UUID v4-like string with time-based entropy mixing for
//          low-collision clientRequestId values
// INPUTS: none
// OUTPUTS: string — format xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx
// SIDE_EFFECTS: none (pure function)
// LINKS: UC-003
// END_CONTRACT: generateGuid
export function generateGuid(): string {
  let d = new Date().getTime();
  let d2 = (typeof performance !== "undefined" && performance.now && performance.now() * 1000) || 0;
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    let r = Math.random() * 16;
    if (d > 0) {
      r = (d + r) % 16 | 0;
      d = Math.floor(d / 16);
    } else {
      r = (d2 + r) % 16 | 0;
      d2 = Math.floor(d2 / 16);
    }
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}

// START_CHANGE_SUMMARY
// LAST_CHANGE: 2026-06-04 — extracted from sync-articles.ts for cross-module reuse
// END_CHANGE_SUMMARY
