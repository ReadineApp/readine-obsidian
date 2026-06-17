// START_MODULE_CONTRACT
// PURPOSE: Unit tests for M-SUPPORT-BUNDLE — bundle composition, null userId path, JSON serializability.
// SCOPE: src/support/support-bundle.test.ts
// DEPENDS: M-SUPPORT-BUNDLE
// LINKS: V-M-SUPPORT-BUNDLE
// ROLE: TEST
// END_MODULE_CONTRACT

// START_MODULE_MAP
// (test file — no public exports)
// END_MODULE_MAP

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => import("../__mocks__/obsidian"));

import { SupportBundle } from "./support-bundle";
import type { PlatformLike, SupportBundleDeps } from "./support-bundle";
import type { LogLine, LogRingBuffer } from "../logs/log-ring-buffer";
import type { AuthService } from "../auth/auth-service";
import type { SettingsManager, SettingsSnapshot } from "../settings/settings-manager";

// START_BLOCK_FIXTURES
function buildPlatform(overrides: Partial<PlatformLike> = {}): PlatformLike {
  return {
    isMobile: () => false,
    getPlatformLabel: () => "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/537.36",
    ...overrides,
  };
}

function buildAuth(userId: string | null): AuthService {
  return {
    getUserId: () => userId,
  } as unknown as AuthService;
}

function buildRingBuffer(lines: LogLine[]): LogRingBuffer {
  return {
    getSnapshot: () => lines,
  } as unknown as LogRingBuffer;
}

function buildSettings(overrides: Partial<SettingsSnapshot> = {}): SettingsManager {
  const snapshot: Partial<SettingsSnapshot> = {
    lastSyncError: null,
    uiLanguage: "en",
    ...overrides,
  };
  return {
    get: <K extends keyof SettingsSnapshot>(key: K): SettingsSnapshot[K] =>
      snapshot[key] as SettingsSnapshot[K],
  } as unknown as SettingsManager;
}

function buildDeps(over: Partial<SupportBundleDeps> = {}): SupportBundleDeps {
  return {
    platform: buildPlatform(),
    auth: buildAuth("user-A"),
    ringBuffer: buildRingBuffer([]),
    settings: buildSettings(),
    pluginVersion: "0.1.0",
    obsidianVersion: "1.5.8",
    ...over,
  };
}
// END_BLOCK_FIXTURES

describe("M-SUPPORT-BUNDLE (V-M-SUPPORT-BUNDLE)", () => {
  let infoSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    infoSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ─── V-M-SUPPORT-BUNDLE scenario-1 ────────────────────────────────────
  describe("scenario-1: bundle includes version + OS + UA + userId + lastError + buffer", () => {
    it("composes all fields when authenticated and logs present", () => {
      const logLines: LogLine[] = [
        { ts: "t1", level: "info", event: "A" },
        { ts: "t2", level: "warn", event: "B" },
      ];
      const sb = new SupportBundle(
        buildDeps({
          platform: buildPlatform({
            isMobile: () => true,
            getPlatformLabel: () => "Obsidian Mobile (iOS)",
          }),
          ringBuffer: buildRingBuffer(logLines),
          settings: buildSettings({
            lastSyncError: "session_expired",
            uiLanguage: "ru",
          }),
        }),
      );

      const bundle = sb.collectBundle();

      expect(bundle.pluginVersion).toBe("0.1.0");
      expect(bundle.obsidianVersion).toBe("1.5.8");
      expect(bundle.os).toBe("iOS");
      expect(bundle.userAgent).toBe("Obsidian Mobile (iOS)");
      expect(bundle.isMobile).toBe(true);
      expect(bundle.userId).toBe("user-A");
      expect(bundle.lastSyncError).toBe("session_expired");
      expect(bundle.logs).toEqual(logLines);
    });

    it("caps logs at 200 entries", () => {
      const lines: LogLine[] = [];
      for (let i = 0; i < 300; i += 1) {
        lines.push({ ts: `t${i}`, level: "info", event: `E${i}` });
      }
      const sb = new SupportBundle(
        buildDeps({ ringBuffer: buildRingBuffer(lines) }),
      );
      const bundle = sb.collectBundle();
      expect(bundle.logs.length).toBe(200);
      // The tail of the buffer is kept.
      expect((bundle.logs[bundle.logs.length - 1] as LogLine).event).toBe("E299");
    });

    it("emits SUPPORT_BUNDLE_COLLECTED log marker", () => {
      const sb = new SupportBundle(buildDeps());
      sb.collectBundle();
      const events = (infoSpy.mock.calls as unknown[][])
        .map((c) => c[0])
        .filter((c): c is Record<string, unknown> => typeof c === "object" && c !== null);
      const ev = events.find((e) => e.event === "SUPPORT_BUNDLE_COLLECTED");
      expect(ev).toBeDefined();
      expect(ev!.module).toBe("M-SUPPORT-BUNDLE");
      expect(ev!.requirement).toBe("UC-019");
    });

    it("infers OS from various platform-label strings", () => {
      const cases: Array<[string, boolean, string]> = [
        ["Obsidian Desktop (Windows)", false, "Windows"],
        ["Obsidian Desktop (Linux)", false, "Linux"],
        ["Obsidian Mobile (Android)", true, "Android"],
        ["Obsidian Mobile (iOS)", true, "iOS"],
        ["Obsidian Desktop (MacOS)", false, "macOS"],
        ["", false, "unknown"],
      ];
      for (const [label, mobile, expected] of cases) {
        const sb = new SupportBundle(
          buildDeps({
            platform: buildPlatform({
              isMobile: () => mobile,
              getPlatformLabel: () => label,
            }),
          }),
        );
        expect(sb.collectBundle().os).toBe(expected);
      }
    });
  });

  // ─── V-M-SUPPORT-BUNDLE scenario-2 ────────────────────────────────────
  describe("scenario-2: userId=null when not authenticated", () => {
    it("returns null userId without throwing", () => {
      const sb = new SupportBundle(buildDeps({ auth: buildAuth(null) }));
      const bundle = sb.collectBundle();
      expect(bundle.userId).toBeNull();
    });

    it("returns null userId when auth.getUserId throws", () => {
      const sb = new SupportBundle(
        buildDeps({
          auth: {
            getUserId: () => {
              throw new Error("auth broken");
            },
          } as unknown as AuthService,
        }),
      );
      const bundle = sb.collectBundle();
      // _safe fallback was null per buildAuth's signature with fallback in collectBundle.
      expect(bundle.userId).toBeNull();
    });

    it("returns empty logs when ringBuffer.getSnapshot throws", () => {
      const sb = new SupportBundle(
        buildDeps({
          ringBuffer: {
            getSnapshot: () => {
              throw new Error("buffer broken");
            },
          } as unknown as LogRingBuffer,
        }),
      );
      const bundle = sb.collectBundle();
      expect(bundle.logs).toEqual([]);
    });
  });

  // ─── V-M-SUPPORT-BUNDLE scenario-3 ────────────────────────────────────
  describe("scenario-3: bundle serialization is key:value format", () => {
    it("serialize() returns key:value lines with logs as compact JSON", () => {
      const sb = new SupportBundle(buildDeps());
      const bundle = sb.collectBundle();
      const text = sb.serialize(bundle);
      expect(typeof text).toBe("string");
      // Key:value format — each line is "key: value".
      const lines = text.split("\n");
      expect(lines.length).toBeGreaterThanOrEqual(7);
      expect(lines[0]).toMatch(/^pluginVersion:/);
      expect(lines.find((l) => l.startsWith("logs:"))).toBeDefined();
      // Logs line must be valid JSON.
      const logsLine = lines.find((l) => l.startsWith("logs:"))!;
      const logsJson = logsLine.slice("logs: ".length);
      const parsed = JSON.parse(logsJson);
      expect(Array.isArray(parsed)).toBe(true);
    });

    it("never throws even if a log entry has non-JSON-friendly shape", () => {
      // Deliberately include weird values. Functions/Symbols are skipped by
      // JSON.stringify (returning undefined for them), so we expect a clean
      // string back.
      const weird: LogLine = {
        ts: "t",
        level: "info",
        event: "weird",
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ...(({ fn: () => 1, sym: Symbol("x") } as unknown) as Record<string, unknown>),
      };
      const sb = new SupportBundle(
        buildDeps({ ringBuffer: buildRingBuffer([weird]) }),
      );
      const bundle = sb.collectBundle();
      expect(() => sb.serialize(bundle)).not.toThrow();
      const text = sb.serialize(bundle);
      const lines = text.split("\n");
      const logsLine = lines.find((l) => l.startsWith("logs:"))!;
      expect(logsLine).toBeDefined();
      const logsJson = logsLine.slice("logs: ".length);
      const parsed = JSON.parse(logsJson);
      expect(Array.isArray(parsed)).toBe(true);
    });
  });
});

// START_CHANGE_SUMMARY
// LAST_CHANGE: 2026-05-13 — initial test suite for V-M-SUPPORT-BUNDLE
// END_CHANGE_SUMMARY
