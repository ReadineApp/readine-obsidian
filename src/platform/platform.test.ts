// START_MODULE_CONTRACT
// PURPOSE: Unit tests for M-PLATFORM — isMobile, getAdaptiveConcurrency, getPlatformLabel, getDeviceInfo.
// SCOPE: src/platform/platform.test.ts
// DEPENDS: M-PLATFORM
// LINKS: V-M-PLATFORM
// ROLE: TEST
// END_MODULE_CONTRACT

// START_MODULE_MAP
// (test file — no public exports)
// END_MODULE_MAP

import { beforeEach, describe, expect, it, vi } from "vitest";
import { Platform, __resetObsidianMock } from "../__mocks__/obsidian";

vi.mock("obsidian", () => import("../__mocks__/obsidian"));

import {
  getAdaptiveConcurrency,
  getDeviceInfo,
  getPlatformLabel,
  isMobile,
} from "./platform";

describe("M-PLATFORM (V-M-PLATFORM)", () => {
  beforeEach(() => {
    __resetObsidianMock();
    vi.restoreAllMocks();
  });

  // V-M-PLATFORM scenario-1: isMobile() returns mock Platform.isMobile
  describe("isMobile()", () => {
    it("scenario-1: returns false on desktop platform", () => {
      Platform.isMobile = false;
      expect(isMobile()).toBe(false);
    });

    it("scenario-1: returns true on mobile platform", () => {
      Platform.isMobile = true;
      expect(isMobile()).toBe(true);
    });

    it("emits PLATFORM_DETECTED log marker on every call", () => {
      const spy = vi.spyOn(console, 'debug').mockImplementation(() => {});
      isMobile();
      expect(spy).toHaveBeenCalled();
      const firstCall = spy.mock.calls[0];
      expect(firstCall).toBeDefined();
      const payload = firstCall![0] as Record<string, unknown>;
      expect(payload.module).toBe("M-PLATFORM");
      expect(payload.anchor).toBe("isMobile");
      expect(payload.event).toBe("PLATFORM_DETECTED");
    });
  });

  // V-M-PLATFORM scenario-2: getAdaptiveConcurrency() — copied from draft, ignores mobile/desktop
  describe("getAdaptiveConcurrency()", () => {
    it("capped by networkLimit (no effectiveType → 4), cpuLimit, hardCap=8", () => {
      // No effectiveType → networkLimit=4. hwConcurrency=16 → cpuLimit=8. hardCap=8 → min=4
      vi.stubGlobal("navigator", {
        hardwareConcurrency: 16,
        userAgent: "",
        connection: undefined,
      });
      expect(getAdaptiveConcurrency()).toBe(4);
    });

    it("cpuLimit = max(2, floor(hwConcurrency/2))", () => {
      // hwConcurrency=3 → cpuLimit = max(2, 1) = 2. networkLimit=4 → min(4,2,8)=2
      vi.stubGlobal("navigator", { hardwareConcurrency: 3, userAgent: "" });
      expect(getAdaptiveConcurrency()).toBe(2);
    });

    it("returns at least 1 even when hardwareConcurrency is 0", () => {
      vi.stubGlobal("navigator", { hardwareConcurrency: 0, userAgent: "" });
      expect(getAdaptiveConcurrency()).toBeGreaterThanOrEqual(1);
    });
  });

  // V-M-PLATFORM scenario-3: getPlatformLabel() returns platform string via Obsidian Platform API
  describe("getPlatformLabel()", () => {
    it("returns desktop OS label when isDesktopApp is true", () => {
      Platform.isDesktopApp = true;
      Platform.isMacOS = true;
      expect(getPlatformLabel()).toBe("Obsidian Desktop (MacOS)");
    });

    it("returns mobile OS label when isMobileApp is true", () => {
      Platform.isDesktopApp = false;
      Platform.isMobileApp = true;
      Platform.isIosApp = true;
      expect(getPlatformLabel()).toBe("Obsidian Mobile (iOS)");
    });

    it("returns 'Obsidian' when neither desktop nor mobile", () => {
      Platform.isDesktopApp = false;
      Platform.isMobileApp = false;
      expect(getPlatformLabel()).toBe("Obsidian");
    });
  });

  // V-M-PLATFORM scenario-4: getDeviceInfo() returns structured info via Platform.* flags
  describe("getDeviceInfo()", () => {
    it("returns iOS device info on iOS mobile", () => {
      Platform.isMobile = true;
      Platform.isIosApp = true;
      const di = getDeviceInfo();
      expect(di.platform).toBe("ios");
      expect(di.operatingSystem).toBe("ios");
      expect(di.model).toBe("iPhone");
      expect(di.manufacturer).toBe("Apple");
    });

    it("returns Android device info on Android mobile", () => {
      Platform.isMobile = true;
      Platform.isAndroidApp = true;
      const di = getDeviceInfo();
      expect(di.platform).toBe("android");
      expect(di.operatingSystem).toBe("android");
      expect(di.model).toBe("unknown");
    });

    it("returns Mac desktop info", () => {
      Platform.isMobile = false;
      Platform.isMacOS = true;
      const di = getDeviceInfo();
      expect(di.platform).toBe("web");
      expect(di.operatingSystem).toBe("mac");
      expect(di.model).toBe("Mac");
      expect(di.manufacturer).toBe("Apple");
    });

    it("returns Windows desktop info", () => {
      Platform.isMobile = false;
      Platform.isWin = true;
      const di = getDeviceInfo();
      expect(di.platform).toBe("web");
      expect(di.operatingSystem).toBe("windows");
      expect(di.model).toBe("PC");
    });

    it("returns unknown when no flags match", () => {
      Platform.isMobile = false;
      Platform.isMacOS = false;
      Platform.isWin = false;
      Platform.isLinux = false;
      Platform.isIosApp = false;
      Platform.isAndroidApp = false;
      const di = getDeviceInfo();
      expect(di.operatingSystem).toBe("unknown");
      expect(di.model).toBe("unknown");
    });
  });
});

// START_CHANGE_SUMMARY
// LAST_CHANGE: 2026-05-13 — initial test suite for V-M-PLATFORM
// END_CHANGE_SUMMARY
