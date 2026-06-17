// START_MODULE_CONTRACT
// PURPOSE: Unit tests for M-I18N — t, setLanguage, detectDefaultLanguage, fallback.
// SCOPE: src/i18n/i18n.test.ts
// DEPENDS: M-I18N
// LINKS: V-M-I18N
// ROLE: TEST
// END_MODULE_CONTRACT

// START_MODULE_MAP
// (test file — no public exports)
// END_MODULE_MAP

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => import("../__mocks__/obsidian"));
// Mock dictionary contents so we don't depend on (intentionally empty) JSON files.
vi.mock("./en.json", () => ({
  default: { greeting: "Hello {name}", only_en: "EN" },
}));
vi.mock("./ru.json", () => ({ default: { greeting: "Привет {name}" } }));
vi.mock("./de.json", () => ({ default: { greeting: "Hallo {name}" } }));
vi.mock("./fr.json", () => ({ default: {} }));
vi.mock("./ja.json", () => ({ default: {} }));
vi.mock("./pt.json", () => ({ default: {} }));
vi.mock("./es.json", () => ({ default: {} }));
vi.mock("./zh.json", () => ({ default: {} }));
vi.mock("./it.json", () => ({ default: {} }));
vi.mock("./ko.json", () => ({ default: {} }));

import { moment, __resetObsidianMock } from "../__mocks__/obsidian";
import {
  SUPPORTED_LANGUAGES,
  __resetI18nForTest,
  detectDefaultLanguage,
  getCurrentLanguage,
  setLanguage,
  t,
} from "./i18n";

describe("M-I18N (V-M-I18N)", () => {
  beforeEach(() => {
    __resetI18nForTest();
    __resetObsidianMock();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // scenario-1: t('key') returns dictionary value for current language
  it("scenario-1: returns dictionary value for current language", async () => {
    await setLanguage("ru");
    expect(t("greeting", { name: "Мир" })).toBe("Привет Мир");
    expect(getCurrentLanguage()).toBe("ru");
  });

  // scenario-2: missing key → fallback to English with warning log
  it("scenario-2: missing key falls back to English and emits I18N_KEY_MISSING", async () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    await setLanguage("en"); // load EN cache first
    await setLanguage("ru"); // RU active; "only_en" missing in RU
    const value = t("only_en");
    expect(value).toBe("EN");
    // ensure the warning fired
    const payload = spy.mock.calls[0]?.[0] as Record<string, unknown> | undefined;
    expect(payload).toBeDefined();
    expect(payload?.module).toBe("M-I18N");
    expect(payload?.event).toBe("I18N_KEY_MISSING");
  });

  it("missing in both langs → returns the key verbatim", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await setLanguage("en");
    expect(t("does_not_exist")).toBe("does_not_exist");
  });

  // scenario-3: setLanguage() switches dictionary + invokes onPersist
  it("scenario-3: switches dictionary and triggers onPersist callback", async () => {
    const onPersist = vi.fn();
    await setLanguage("de", onPersist);
    expect(getCurrentLanguage()).toBe("de");
    expect(onPersist).toHaveBeenCalledWith("de");
    expect(t("greeting", { name: "Welt" })).toBe("Hallo Welt");
  });

  // scenario-4: 10 dictionary files (en/ru/de/fr/ja/pt/es/zh/it/ko) loadable
  it("scenario-4: all 10 dictionary files load without throwing", async () => {
    expect(SUPPORTED_LANGUAGES).toHaveLength(10);
    for (const lang of SUPPORTED_LANGUAGES) {
      await expect(setLanguage(lang)).resolves.toBeUndefined();
    }
  });

  describe("detectDefaultLanguage()", () => {
    it("returns Obsidian moment.locale() match", () => {
      moment.locale("ru-RU");
      expect(detectDefaultLanguage()).toBe("ru");
    });

    it("falls back to navigator.language when moment locale is unsupported", () => {
      moment.locale("xx-YY");
      vi.stubGlobal("navigator", { language: "fr-FR" });
      expect(detectDefaultLanguage()).toBe("fr");
    });

    it("falls back to 'en' on no signal", () => {
      moment.locale("xx-YY");
      vi.stubGlobal("navigator", { language: "" });
      expect(detectDefaultLanguage()).toBe("en");
    });
  });

  it("param substitution leaves unknown placeholders intact", async () => {
    await setLanguage("en");
    expect(t("greeting")).toBe("Hello {name}");
    expect(t("greeting", {})).toBe("Hello {name}");
  });
});

// START_CHANGE_SUMMARY
// LAST_CHANGE: 2026-05-13 — initial test suite for V-M-I18N
// END_CHANGE_SUMMARY
