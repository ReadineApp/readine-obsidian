// START_MODULE_CONTRACT
// PURPOSE: Unit tests for M-SUPPORT-UI — modal preview, Send mailto URL composition, Copy clipboard wiring, full collect+preview+send cycle.
// SCOPE: src/ui/support-ui.test.ts
// DEPENDS: M-SUPPORT-UI, M-SUPPORT-BUNDLE
// LINKS: V-M-SUPPORT-UI
// ROLE: TEST
// END_MODULE_CONTRACT

// START_MODULE_MAP
// (test file — no public exports)
// END_MODULE_MAP

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => import("../__mocks__/obsidian"));

import {
  App as MockApp,
  __getNotices,
  __resetObsidianMock,
} from "../__mocks__/obsidian";
import type { App as ObsidianApp } from "obsidian";
import {
  MAILTO_THRESHOLD,
  SUPPORT_EMAIL,
  SupportModal,
  SupportUI,
} from "./support-ui";
import { SupportBundle } from "../support/support-bundle";
import type { I18n } from "../i18n/i18n-bridge";
import type { LogLine, LogRingBuffer } from "../logs/log-ring-buffer";
import type { AuthService } from "../auth/auth-service";
import type { SettingsManager, SettingsSnapshot } from "../settings/settings-manager";
import type { PlatformLike } from "../support/support-bundle";

// Mock App carries a nominal type distinct from the real obsidian.App; cast.
const App = MockApp as unknown as new () => ObsidianApp;

// START_BLOCK_FIXTURES
const I18N_STUB: I18n = {
  t: (key) => `[${key}]`,
  getCurrentLanguage: () => "en",
};

function buildBundle(logLines: LogLine[] = []): SupportBundle {
  const platform: PlatformLike = {
    isMobile: () => false,
    getPlatformLabel: () => "Mozilla/5.0 (Macintosh)",
  };
  const auth = { getUserId: () => "user-A" } as unknown as AuthService;
  const ringBuffer = {
    getSnapshot: () => logLines,
  } as unknown as LogRingBuffer;
  const settings = {
    get: <K extends keyof SettingsSnapshot>(_key: K): SettingsSnapshot[K] => null as SettingsSnapshot[K],
  } as unknown as SettingsManager;
  return new SupportBundle({
    platform,
    auth,
    ringBuffer,
    settings,
    pluginVersion: "0.1.0",
    obsidianVersion: "1.5.8",
  });
}
// END_BLOCK_FIXTURES

describe("M-SUPPORT-UI (V-M-SUPPORT-UI)", () => {
  let infoSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    __resetObsidianMock();
    infoSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ─── V-M-SUPPORT-UI scenario-1 ─────────────────────────────────────────
  describe("scenario-1: modal shows preview of bundle", () => {
    it("opens, renders bundle text into the textarea, and emits SUPPORT_UI_OPEN", () => {
      const app = new App();
      const bundle = buildBundle([{ ts: "t", level: "info", event: "X" }]);
      const ui = new SupportUI(app, { bundle, i18n: I18N_STUB });

      const modal = ui.open();

      // After open(), the modal's contentEl has a textarea pre-populated.
      const text = modal.__getCurrentTextForTests();
      expect(text.length).toBeGreaterThan(0);
      // Bundle JSON contains a known field.
      expect(text).toContain("pluginVersion");
      expect(text).toContain("0.1.0");

      const events = (infoSpy.mock.calls as unknown[][])
        .map((c) => c[0])
        .filter((c): c is Record<string, unknown> => typeof c === "object" && c !== null);
      const open = events.find((e) => e.event === "SUPPORT_UI_OPEN");
      expect(open).toBeDefined();
      expect(open!.anchor).toBe("onOpen:BLOCK_RENDER_PREVIEW");
    });

    it("renders large-bundle hint when serialized exceeds MAILTO_THRESHOLD", () => {
      const big: LogLine[] = [];
      for (let i = 0; i < 200; i += 1) {
        big.push({
          ts: `2026-05-13T19:00:00.${i}Z`,
          level: "info",
          event: `EVT_${i}`,
          // pad to ensure size > threshold
          message: "x".repeat(50),
        });
      }
      const app = new App();
      const bundle = buildBundle(big);
      const ui = new SupportUI(app, { bundle, i18n: I18N_STUB });
      const modal = ui.open();

      expect(modal.__getCurrentTextForTests().length).toBeGreaterThan(MAILTO_THRESHOLD);
      // The "large bundle hint" was rendered.
      const events = (infoSpy.mock.calls as unknown[][])
        .map((c) => c[0])
        .filter((c): c is Record<string, unknown> => typeof c === "object" && c !== null);
      const open = events.find((e) => e.event === "SUPPORT_UI_OPEN");
      expect(open!.exceedsMailto).toBe(true);
    });
  });

  // ─── V-M-SUPPORT-UI scenario-2 ─────────────────────────────────────────
  describe("scenario-2: Send opens mailto with bundle in body", () => {
    it("composes mailto URL with subject + URL-encoded body", () => {
      const calls: string[] = [];
      const app = new App();
      const bundle = buildBundle();
      const ui = new SupportUI(app, {
        bundle,
        i18n: I18N_STUB,
        openMailto: (url) => calls.push(url),
      });
      const modal = ui.open();
      modal.__triggerSendForTests();

      expect(calls).toHaveLength(1);
      const url = calls[0]!;
      expect(url.startsWith(`mailto:${SUPPORT_EMAIL}?subject=`)).toBe(true);
      expect(url).toContain("body=");
      // The bundle JSON content is URL-encoded — decodeURIComponent recovers it.
      const bodyParam = url.split("body=")[1] ?? "";
      const decoded = decodeURIComponent(bodyParam);
      expect(decoded).toContain("pluginVersion");
    });

    it("emits SUPPORT_UI_SEND log marker", () => {
      const app = new App();
      const bundle = buildBundle();
      const ui = new SupportUI(app, {
        bundle,
        i18n: I18N_STUB,
        openMailto: () => {},
      });
      const modal = ui.open();
      modal.__triggerSendForTests();

      const events = (infoSpy.mock.calls as unknown[][])
        .map((c) => c[0])
        .filter((c): c is Record<string, unknown> => typeof c === "object" && c !== null);
      const send = events.find((e) => e.event === "SUPPORT_UI_SEND");
      expect(send).toBeDefined();
      expect(send!.anchor).toBe("onSend:BLOCK_SEND");
    });
  });

  // ─── V-M-SUPPORT-UI scenario-3 ─────────────────────────────────────────
  describe("scenario-3: Copy writes bundle to clipboard", () => {
    it("invokes clipboard.writeText with serialized bundle", async () => {
      const writes: string[] = [];
      const clip = {
        async writeText(text: string): Promise<void> {
          writes.push(text);
        },
      };
      const app = new App();
      const bundle = buildBundle();
      const ui = new SupportUI(app, { bundle, i18n: I18N_STUB, clipboard: clip });
      const modal = ui.open();
      await modal.__triggerCopyForTests();

      expect(writes).toHaveLength(1);
      expect(writes[0]).toContain("pluginVersion");
      // Surfaces a Notice.
      expect(__getNotices().some((n) => n.message === "[support.copied]")).toBe(true);
    });

    it("emits a Notice on clipboard failure", async () => {
      const clip = {
        async writeText(): Promise<void> {
          throw new Error("clipboard nope");
        },
      };
      const app = new App();
      const bundle = buildBundle();
      const ui = new SupportUI(app, { bundle, i18n: I18N_STUB, clipboard: clip });
      const modal = ui.open();
      await modal.__triggerCopyForTests();

      expect(__getNotices().some((n) => n.message === "[support.copy_failed]")).toBe(true);
      expect(warnSpy).toHaveBeenCalled();
    });

    it("surfaces Notice when no clipboard API is present at all", async () => {
      const app = new App();
      const bundle = buildBundle();
      const ui = new SupportUI(app, {
        bundle,
        i18n: I18N_STUB,
        // explicitly pass an empty object that lacks writeText
        clipboard: undefined,
      });
      const modal = ui.open();
      // Ensure navigator.clipboard isn't lying around from a previous test.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const g = globalThis as any;
      if (g.navigator && g.navigator.clipboard) delete g.navigator.clipboard;
      await modal.__triggerCopyForTests();

      expect(__getNotices().some((n) => n.message === "[support.copy_failed]")).toBe(true);
    });
  });

  // ─── V-M-SUPPORT-UI scenario-4 (integration) ───────────────────────────
  describe("scenario-4 (integration): full collect + preview + send cycle", () => {
    it("opens → preview text reflects bundle → textarea is readonly → Send uses original text", () => {
      const calls: string[] = [];
      const app = new App();
      const bundle = buildBundle([{ ts: "t", level: "info", event: "X" }]);
      const ui = new SupportUI(app, {
        bundle,
        i18n: I18N_STUB,
        openMailto: (url) => calls.push(url),
      });
      const modal = ui.open() as SupportModal;

      const root = modal.contentEl as unknown as {
        querySelector(s: string): { value: string; readOnly: boolean; dispatchEvent(e: { type: string }): boolean } | null;
      };
      const ta = root.querySelector("textarea");
      expect(ta).not.toBeNull();
      // Textarea is readonly — editing the DOM value should not change the sent text.
      expect(ta!.readOnly).toBe(true);
      ta!.value = "EDITED";
      ta!.dispatchEvent({ type: "input" });

      modal.__triggerSendForTests();

      expect(calls).toHaveLength(1);
      const url = calls[0]!;
      const decoded = decodeURIComponent(url.split("body=")[1] ?? "");
      // The sent text is the original bundle, not the attempted edit.
      expect(decoded).toContain("pluginVersion: 0.1.0");
    });

    it("Cancel button closes the modal", () => {
      const app = new App();
      const bundle = buildBundle();
      const ui = new SupportUI(app, { bundle, i18n: I18N_STUB });
      const modal = ui.open();

      // Find the Cancel button by its rendered text.
      const root = modal.contentEl as unknown as {
        querySelectorAll(s: string): Array<{ textContent: string; dispatchEvent(e: { type: string }): boolean }>;
      };
      const buttons = root.querySelectorAll("button");
      const cancel = buttons.find((b) => (b.textContent ?? "").includes("support.modal.cancel"));
      expect(cancel).toBeDefined();
      const closeSpy = vi.spyOn(modal, "close");
      cancel!.dispatchEvent({ type: "click" });
      expect(closeSpy).toHaveBeenCalled();
    });
  });
});

// START_CHANGE_SUMMARY
// LAST_CHANGE: 2026-05-13 — initial test suite for V-M-SUPPORT-UI
// END_CHANGE_SUMMARY
