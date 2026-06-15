// START_MODULE_CONTRACT
// PURPOSE: Structural bridge between M-I18N (module-scoped functions) and consumers that prefer dependency-injected access. Wraps t()/getCurrentLanguage()/setLanguage() into an injectable I18n instance so M-AUTH-SERVICE / M-ERROR-HANDLER and tests can swap a stub without touching the module-level state.
// SCOPE: src/i18n/i18n-bridge.ts
// DEPENDS: M-I18N
// LINKS: UC-001, UC-020, V-M-I18N
// ROLE: RUNTIME
// END_MODULE_CONTRACT

// START_MODULE_MAP
// I18n - structural interface for injection: t(key, params?), getCurrentLanguage()
// createDefaultI18n - factory returning the global-state-backed implementation
// END_MODULE_MAP

import { getCurrentLanguage, t } from "./i18n";
import type { LangCode } from "./i18n";

// START_BLOCK_TYPES
/**
 * Structural I18n bridge consumed by services that prefer DI. Test stubs can
 * implement this with a plain object literal:
 *
 *   const i18n: I18n = {
 *     t: (key) => `__${key}__`,
 *     getCurrentLanguage: () => "en",
 *   };
 */
export interface I18n {
  t(key: string, params?: Record<string, string>): string;
  getCurrentLanguage(): LangCode;
}
// END_BLOCK_TYPES

// START_CONTRACT: createDefaultI18n
// PURPOSE: factory wrapping the module-scoped t/getCurrentLanguage into the I18n interface
// INPUTS: none
// OUTPUTS: I18n — delegates straight to the M-I18N module exports
// SIDE_EFFECTS: none
// LINKS: UC-020, V-M-I18N
// END_CONTRACT: createDefaultI18n
export function createDefaultI18n(): I18n {
  return {
    t,
    getCurrentLanguage,
  };
}

// START_CHANGE_SUMMARY
// LAST_CHANGE: 2026-05-13 — initial bridge for Phase 4 DI consumers
// END_CHANGE_SUMMARY
