// START_MODULE_CONTRACT
// PURPOSE: Unit tests for M-SETTINGS-DEFAULTS — getDefaults() platform branching, fixed values for non-platform-aware keys, and the auto-detection wrapper getDefaultsForCurrentPlatform().
// SCOPE: src/settings/settings-defaults.test.ts
// DEPENDS: M-SETTINGS-DEFAULTS, M-PLATFORM
// LINKS: V-M-SETTINGS-DEFAULTS
// ROLE: TEST
// END_MODULE_CONTRACT

// START_MODULE_MAP
// (test file — no public exports)
// END_MODULE_MAP

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => import("../__mocks__/obsidian"));

import { Platform, __resetObsidianMock } from "../__mocks__/obsidian";
import {
  getDefaults,
  getDefaultsForCurrentPlatform,
} from "./settings-defaults";

describe("M-SETTINGS-DEFAULTS (V-M-SETTINGS-DEFAULTS)", () => {
  beforeEach(() => {
    __resetObsidianMock();
    vi.spyOn(console, 'debug').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // V-M-SETTINGS-DEFAULTS scenario-1: getDefaults(desktop) → networkForArticles='always'
  describe("scenario-1: desktop defaults", () => {
    it("sets networkForArticles to 'always' on desktop", () => {
      const d = getDefaults("desktop");
      expect(d.networkForArticles).toBe("always");
    });
  });

  // V-M-SETTINGS-DEFAULTS scenario-2: getDefaults(mobile) → networkForArticles='Wi-Fi-only'
  describe("scenario-2: mobile defaults", () => {
    it("sets networkForArticles to 'Wi-Fi-only' on mobile", () => {
      const d = getDefaults("mobile");
      expect(d.networkForArticles).toBe("Wi-Fi-only");
    });
  });

  // V-M-SETTINGS-DEFAULTS scenario-3: other defaults platform-agnostic
  describe("scenario-3: non-platform-aware defaults", () => {
    it("returns identical values for all non-network keys on mobile and desktop", () => {
      const desktop = getDefaults("desktop");
      const mobile = getDefaults("mobile");
      const omitNet = (s: ReturnType<typeof getDefaults>) => {
        const { networkForArticles: _drop, ...rest } = s;
        void _drop;
        return rest;
      };
      expect(omitNet(desktop)).toEqual(omitNet(mobile));
    });

    it("matches the contract values in docs/development-plan.xml", () => {
      const d = getDefaults("desktop");
      expect(d.sessionId).toBeNull();
      expect(d.userId).toBeNull();
      expect(d.outputFormat).toBe("markdown");
      expect(d.pathTemplate).toBe(
        "Readine/{feedName}/{yyyy}-{mm}/{title}.md",
      );
      expect(d.deletePolicy).toBe("keep");
      expect(d.autoSyncInterval).toBe(5);
      expect(d.limitCacheDays).toBe("off");
      expect(d.uiLanguage).toBe("en");
      expect(d.lastSyncError).toBeNull();
    });

    it("returns a fresh object per call (no shared mutable references)", () => {
      const a = getDefaults("desktop");
      const b = getDefaults("desktop");
      expect(a).not.toBe(b);
    });
  });

  describe("getDefaultsForCurrentPlatform()", () => {
    it("picks mobile defaults when Platform.isMobile is true", () => {
      Platform.isMobile = true;
      const d = getDefaultsForCurrentPlatform();
      expect(d.networkForArticles).toBe("Wi-Fi-only");
    });

    it("picks desktop defaults when Platform.isMobile is false", () => {
      Platform.isMobile = false;
      const d = getDefaultsForCurrentPlatform();
      expect(d.networkForArticles).toBe("always");
    });
  });
});

// START_CHANGE_SUMMARY
// LAST_CHANGE: 2026-05-13 — initial V-M-SETTINGS-DEFAULTS scenarios 1–3
// END_CHANGE_SUMMARY
