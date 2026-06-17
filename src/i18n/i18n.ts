// START_MODULE_CONTRACT
// PURPOSE: i18n helper. 10-language flat-key dictionaries; lazy load; English fallback on missing key.
// SCOPE: src/i18n/i18n.ts
// DEPENDS: M-SETTINGS-MANAGER
// LINKS: UC-020, V-M-I18N
// ROLE: RUNTIME
// END_MODULE_CONTRACT

// START_MODULE_MAP
// LangCode - union of supported 10 ISO 639-1 language codes
// SUPPORTED_LANGUAGES - exported array of LangCode for iteration
// t - translate key for current language with optional param substitution
// setLanguage - switch current dictionary; calls optional onPersist callback
// getCurrentLanguage - returns active LangCode
// detectDefaultLanguage - detect from Obsidian moment.locale() or navigator.language
// __resetI18nForTest - testing-only reset hook (cache + current language)
// END_MODULE_MAP

import { moment } from "obsidian";

// START_BLOCK_TYPES
export type LangCode =
  | "en"
  | "ru"
  | "de"
  | "fr"
  | "ja"
  | "pt"
  | "es"
  | "zh"
  | "it"
  | "ko";

export const SUPPORTED_LANGUAGES: readonly LangCode[] = [
  "en",
  "ru",
  "de",
  "fr",
  "ja",
  "pt",
  "es",
  "zh",
  "it",
  "ko",
] as const;

const DEFAULT_LANG: LangCode = "en";

type Dictionary = Record<string, string>;
// END_BLOCK_TYPES

// START_BLOCK_LAZY_LOADERS
import en from "./en.json";
import ru from "./ru.json";
import de from "./de.json";
import fr from "./fr.json";
import ja from "./ja.json";
import pt from "./pt.json";
import es from "./es.json";
import zh from "./zh.json";
import it from "./it.json";
import ko from "./ko.json";

const rawDicts: Record<string, Dictionary> = {
  en: en as unknown as Dictionary,
  ru: ru as unknown as Dictionary,
  de: de as unknown as Dictionary,
  fr: fr as unknown as Dictionary,
  ja: ja as unknown as Dictionary,
  pt: pt as unknown as Dictionary,
  es: es as unknown as Dictionary,
  zh: zh as unknown as Dictionary,
  it: it as unknown as Dictionary,
  ko: ko as unknown as Dictionary,
};

const dictCache: Partial<Record<LangCode, Dictionary>> = {};
const inflight: Partial<Record<LangCode, Promise<Dictionary>>> = {};

async function loadDictionary(lang: LangCode): Promise<Dictionary> {
  const cached = dictCache[lang];
  if (cached) return cached;
  const pending = inflight[lang];
  if (pending) return pending;
  const promise = Promise.resolve(rawDicts[lang] ?? {}).then((dict) => {
    dictCache[lang] = dict;
    delete inflight[lang];
    return dict;
  });
  inflight[lang] = promise;
  return promise;
}
// END_BLOCK_LAZY_LOADERS

// START_BLOCK_INTERNAL_LOG
function logWarn(
  anchor: string,
  event: string,
  belief: string,
  details: Record<string, unknown> = {},
): void {
  console.warn({
    ts: new Date().toISOString(),
    level: "warn",
    anchor,
    module: "M-I18N",
    requirement: "UC-020",
    event,
    belief,
    ...details,
  });
}
// END_BLOCK_INTERNAL_LOG

let currentLang: LangCode = DEFAULT_LANG;

// START_CONTRACT: t
// PURPOSE: translate a flat key for the current language, with optional {param} substitution
// INPUTS: key: string, params?: Record<string, string>
// OUTPUTS: string — translation, or English fallback, or the raw key itself
// SIDE_EFFECTS: emits I18N_KEY_MISSING warning when the key is absent from current + fallback dictionaries; triggers lazy dictionary load
// LINKS: UC-020, V-M-I18N
// END_CONTRACT: t
export function t(key: string, params?: Record<string, string>): string {
  const dict = dictCache[currentLang];
  let raw: string | undefined;
  if (dict !== undefined) {
    const candidate = dict[key];
    if (typeof candidate === "string") raw = candidate;
  }

  // Missing from active language is itself worth surfacing — useful for translators
  // to discover untranslated keys even when EN fallback covers the runtime gap.
  if (raw === undefined) {
    logWarn("t", "I18N_KEY_MISSING", "key absent from current dictionary", {
      key,
      lang: currentLang,
    });
    void loadDictionary(currentLang).catch((err) => {
      logWarn("t", "I18N_DICT_LOAD_FAIL", "failed to load dictionary", { lang: currentLang, err: String(err) });
    });
  }

  if (raw === undefined && currentLang !== DEFAULT_LANG) {
    const fallback = dictCache[DEFAULT_LANG];
    if (fallback !== undefined) {
      const candidate = fallback[key];
      if (typeof candidate === "string") raw = candidate;
    } else {
      void loadDictionary(DEFAULT_LANG).catch((err) => {
        logWarn("t", "I18N_DICT_FALLBACK_FAIL", "failed to load fallback dictionary", { err: String(err) });
      });
    }
  }

  if (raw === undefined) {
    raw = key;
  }

  if (params) {
    return raw.replace(/\{(\w+)\}/g, (_match, name: string) => {
      const replacement = params[name];
      return typeof replacement === "string" ? replacement : `{${name}}`;
    });
  }
  return raw;
}

// START_CONTRACT: setLanguage
// PURPOSE: switch active language; eagerly loads the new dictionary; optionally persists via callback
// INPUTS: lang: LangCode, onPersist?: (lang: LangCode) => void
// OUTPUTS: Promise<void> — resolves once the dictionary is loaded
// SIDE_EFFECTS: updates currentLang; invokes onPersist (Phase-3+ wires persistence)
// LINKS: UC-020, V-M-I18N
// END_CONTRACT: setLanguage
export async function setLanguage(
  lang: LangCode,
  onPersist?: (lang: LangCode) => void,
): Promise<void> {
  currentLang = lang;
  await loadDictionary(lang).catch((err: unknown) => {
    logWarn("setLanguage", "I18N_DICT_LOAD_FAIL", "dictionary load failed", {
      lang,
      err: String(err),
    });
    return {};
  });
  if (onPersist) {
    try {
      onPersist(lang);
    } catch (err: unknown) {
      logWarn("setLanguage", "I18N_PERSIST_FAIL", "persistence callback threw", {
        err: String(err),
      });
    }
  }
}

// START_CONTRACT: getCurrentLanguage
// PURPOSE: read the currently active language code
// INPUTS: none
// OUTPUTS: LangCode
// SIDE_EFFECTS: none
// LINKS: UC-020, V-M-I18N
// END_CONTRACT: getCurrentLanguage
export function getCurrentLanguage(): LangCode {
  return currentLang;
}

// START_CONTRACT: detectDefaultLanguage
// PURPOSE: pick a sensible default LangCode based on the host environment
// INPUTS: none
// OUTPUTS: LangCode — one of SUPPORTED_LANGUAGES; falls back to 'en'
// SIDE_EFFECTS: none
// LINKS: UC-020, V-M-I18N
// END_CONTRACT: detectDefaultLanguage
export function detectDefaultLanguage(): LangCode {
  // Try Obsidian's moment.locale() first; degrade gracefully if it throws.
  try {
    const raw = typeof moment?.locale === "function" ? moment.locale() : undefined;
    const matched = matchLang(raw);
    if (matched) return matched;
  } catch {
    // ignore — fall through to navigator
  }
  if (typeof navigator !== "undefined" && typeof navigator.language === "string") {
    const matched = matchLang(navigator.language);
    if (matched) return matched;
  }
  return DEFAULT_LANG;
}

function matchLang(raw: string | undefined): LangCode | null {
  if (typeof raw !== "string" || raw.length === 0) return null;
  const head = raw.split(/[-_]/)[0]?.toLowerCase();
  if (!head) return null;
  for (const lang of SUPPORTED_LANGUAGES) {
    if (lang === head) return lang;
  }
  return null;
}

// START_CONTRACT: __resetI18nForTest
// PURPOSE: testing-only reset; clears dictionary cache and active language
// INPUTS: none
// OUTPUTS: void
// SIDE_EFFECTS: mutates module-level cache + currentLang
// LINKS: V-M-I18N
// END_CONTRACT: __resetI18nForTest
export function __resetI18nForTest(): void {
  currentLang = DEFAULT_LANG;
  for (const lang of SUPPORTED_LANGUAGES) {
    delete dictCache[lang];
    delete inflight[lang];
  }
}

// START_CHANGE_SUMMARY
// LAST_CHANGE: 2026-05-13 — initial implementation per Phase 1; lazy persistence via callback
// END_CHANGE_SUMMARY
