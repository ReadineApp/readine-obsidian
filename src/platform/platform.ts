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
// getPlatformLabel - returns human-readable platform string via Obsidian Platform API (UC-019)
// getDeviceInfo - returns structured DeviceInfo dict for Logs API (UC-018)
// END_MODULE_MAP

import { Platform } from "obsidian";

// ── public types ──────────────────────────────────────────────

export interface DeviceInfo {
  platform: "web" | "ios" | "android";
  isVirtual: false;
  operatingSystem: "ios" | "android" | "mac" | "windows" | "linux" | "unknown";
  osVersion: string;
  webViewVersion: string;
  model: string;
  manufacturer: string;
}

// START_BLOCK_INTERNAL_LOG
// START_BLOCK_PROCESS_VERSIONS
/**
 * Safely read Electron process.versions (available in Obsidian Desktop).
 * On mobile / headless tests these fields are absent — return "".
 */
function readProcessVersions(): { osVersion: string; webViewVersion: string } {
  try {
    const pv = (globalThis as unknown as {
      process?: { versions?: Record<string, string> };
    }).process?.versions;
    if (pv) {
      return {
        osVersion: pv.electron ?? "",
        webViewVersion: pv.chrome ?? "",
      };
    }
  } catch { /* node-free env (mobile, non-Electron tests) */ }
  return { osVersion: "", webViewVersion: "" };
}
// END_BLOCK_PROCESS_VERSIONS
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
  const conn = (navigator as unknown as { connection?: { effectiveType?: string } }).connection;
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

// START_CONTRACT: getPlatformLabel
// PURPOSE: return a human-readable platform label via Obsidian Platform API (no navigator)
// INPUTS: none
// OUTPUTS: string — "Obsidian Desktop (MacOS)" / "Obsidian Mobile (iOS)" / "Obsidian"
// SIDE_EFFECTS: none
// LINKS: UC-019, V-M-PLATFORM
// END_CONTRACT: getPlatformLabel
export function getPlatformLabel(): string {
  if (Platform.isDesktopApp) {
    const os = Platform.isMacOS ? "MacOS" : Platform.isWin ? "Windows" : Platform.isLinux ? "Linux" : "Desktop";
    return `Obsidian Desktop (${os})`;
  }
  if (Platform.isMobileApp) {
    const os = Platform.isIosApp ? "iOS" : Platform.isAndroidApp ? "Android" : "Mobile";
    return `Obsidian Mobile (${os})`;
  }
  return "Obsidian";
}

// START_CONTRACT: getDeviceInfo
// PURPOSE: assemble structured device info for Logs API, backed by Platform.* flags (no user-agent parsing)
// INPUTS: none
// OUTPUTS: DeviceInfo — platform / operatingSystem / model / manufacturer / osVersion / webViewVersion
// SIDE_EFFECTS: none
// LINKS: UC-018, V-M-PLATFORM
// END_CONTRACT: getDeviceInfo
export function getDeviceInfo(): DeviceInfo {
  const mobile = Boolean(Platform.isMobile);

  let operatingSystem: DeviceInfo["operatingSystem"] = "unknown";
  let model = "unknown";
  let manufacturer = "unknown";

  if (Platform.isIosApp) {
    operatingSystem = "ios";
    model = Platform.isMobile ? "iPhone" : "iPad";
    manufacturer = "Apple";
  } else if (Platform.isAndroidApp) {
    operatingSystem = "android";
    manufacturer = "unknown";
  } else if (Platform.isMacOS) {
    operatingSystem = "mac";
    model = "Mac";
    manufacturer = "Apple";
  } else if (Platform.isWin) {
    operatingSystem = "windows";
    model = "PC";
    manufacturer = "Microsoft";
  } else if (Platform.isLinux) {
    operatingSystem = "linux";
    model = "PC";
  }

  const platform: DeviceInfo["platform"] = mobile
    ? (operatingSystem === "ios" ? "ios" : "android")
    : "web";

  const { osVersion, webViewVersion } = readProcessVersions();

  return {
    platform,
    isVirtual: false,
    operatingSystem,
    osVersion,
    webViewVersion,
    model,
    manufacturer,
  };
}

// START_CHANGE_SUMMARY
// LAST_CHANGE: 2026-05-13 — initial implementation per Phase 1
// LAST_CHANGE: 2026-06-17 — getUserAgent → getPlatformLabel + getDeviceInfo; parseOSFromUA eliminated (review compliance)
// LAST_CHANGE: 2026-06-17 — getDeviceInfo: populate osVersion/webViewVersion from process.versions (Electron) instead of hardcoded ""
// END_CHANGE_SUMMARY
