// START_MODULE_CONTRACT
// PURPOSE: Platform detection wrapper. Pure adapter over Obsidian Platform + navigator.
// SCOPE: src/platform/platform.ts
// DEPENDS: none
// LINKS: UC-004, UC-009, UC-019, V-M-PLATFORM
// ROLE: RUNTIME
// END_MODULE_CONTRACT

// START_MODULE_MAP
// isMobile - returns true on Obsidian Mobile (delegates to Platform.isMobile)
// getAdaptiveConcurrency - returns adaptive concurrency based on network + CPU (copied from draft)
// getUserAgent - returns navigator.userAgent for support-bundle (UC-019)
// END_MODULE_MAP

import { Platform } from "obsidian";

// START_BLOCK_INTERNAL_LOG
/**
 * Lightweight structured logger. Emits a single console.info call so tests can
 * spy on it and assert required markers from `verification-plan.xml`.
 */
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
    module: "M-PLATFORM",
    requirement: "UC-004",
    event,
    belief,
    ...details,
  });
}
// END_BLOCK_INTERNAL_LOG

// START_CONTRACT: isMobile
// PURPOSE: detect Obsidian Mobile runtime
// INPUTS: none
// OUTPUTS: boolean — true on Obsidian Mobile
// SIDE_EFFECTS: emits PLATFORM_DETECTED log event
// LINKS: UC-004, V-M-PLATFORM
// END_CONTRACT: isMobile
export function isMobile(): boolean {
  const value = Boolean(Platform.isMobile);
  logInfo("isMobile", "PLATFORM_DETECTED", "Platform.isMobile read", {
    isMobile: value,
  });
  return value;
}

// START_CONTRACT: getAdaptiveConcurrency
// PURPOSE: return adaptive concurrency based on network quality + CPU cores (copied from draft/reusable/utils.ts)
// INPUTS: none
// OUTPUTS: number — between 1 and 8 based on effectiveType + cores
// SIDE_EFFECTS: none
// LINKS: UC-009, V-M-PLATFORM
// END_CONTRACT: getAdaptiveConcurrency
export function getAdaptiveConcurrency(): number {
  const conn = (navigator as any).connection;
  const effectiveType = conn?.effectiveType as string | undefined;

  const networkLimitMap: Record<string, number> = {
    "slow-2g": 1,
    "2g": 2,
    "3g": 3,
    "4g": 6,
  };
  const networkLimit = effectiveType ? (networkLimitMap[effectiveType] ?? 4) : 4;

  const cores = navigator.hardwareConcurrency ?? 4;
  const cpuLimit = Math.max(2, Math.floor(cores / 2));

  const hardCap = 8;

  return Math.min(networkLimit, cpuLimit, hardCap);
}

// START_CONTRACT: getUserAgent
// PURPOSE: return navigator.userAgent for support-bundle assembly
// INPUTS: none
// OUTPUTS: string — empty string when navigator is unavailable (non-browser env)
// SIDE_EFFECTS: none
// LINKS: UC-019, V-M-PLATFORM
// END_CONTRACT: getUserAgent
export function getUserAgent(): string {
  if (typeof navigator === "undefined" || typeof navigator.userAgent !== "string") {
    return "";
  }
  return navigator.userAgent;
}

// START_CHANGE_SUMMARY
// LAST_CHANGE: 2026-05-13 — initial implementation per Phase 1
// END_CHANGE_SUMMARY
