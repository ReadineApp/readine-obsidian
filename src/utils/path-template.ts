// START_MODULE_CONTRACT
// PURPOSE: Pure render of pathTemplate with placeholders + cross-OS sanitization. Hot spot ⚠#11.
// SCOPE: src/utils/path-template.ts
// DEPENDS: M-PLATFORM
// LINKS: UC-006, UC-003, UC-014, V-M-PATH-TEMPLATE
// ROLE: RUNTIME
// END_MODULE_CONTRACT

// START_MODULE_MAP
// OSKind - supported OS identifier union
// KNOWN_PLACEHOLDERS - list of accepted template placeholders (sans braces)
// renderPath - substitute placeholders into template, return sanitized path
// sanitizeComponent - replace OS-invalid chars (/\:*?"<>|) → _, truncate
// validateTemplate - check template for unknown placeholders / emptiness
// END_MODULE_MAP

import { isMobile } from "../platform/platform";

// START_BLOCK_TYPES
export type OSKind = "win32" | "darwin" | "linux" | "ios" | "android";

export const KNOWN_PLACEHOLDERS: readonly string[] = [
  "feedName",
  "feedId",
  "tag",
  "firstTag",
  "yyyy",
  "mm",
  "dd",
  "title",
  "articleId",
] as const;

const PLACEHOLDER_RE = /\{([a-zA-Z][a-zA-Z0-9]*)\}/g;

/** Characters disallowed on Windows; we sanitize for the strictest superset on every OS. */
const INVALID_CHARS_RE = /[\\/:*?"<>|]/g;

/** Per-OS upper bounds. Conservative — leaves headroom for vault prefix. */
const COMPONENT_LIMITS: Record<OSKind, number> = {
  win32: 200,
  darwin: 200,
  linux: 200,
  ios: 200,
  android: 200,
};

const FULL_PATH_LIMITS: Record<OSKind, number> = {
  win32: 260,
  darwin: 1000,
  linux: 1000,
  ios: 1000,
  android: 1000,
};
// END_BLOCK_TYPES

// START_BLOCK_INTERNAL_LOG
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
    module: "M-PATH-TEMPLATE",
    requirement: "UC-006",
    event,
    belief,
    ...details,
  });
}

function logWarn(
  anchor: string,
  event: string,
  belief: string,
  details: Record<string, unknown> = {},
): void {
  // eslint-disable-next-line no-console
  console.warn({
    ts: new Date().toISOString(),
    level: "warn",
    anchor,
    module: "M-PATH-TEMPLATE",
    requirement: "UC-006",
    event,
    belief,
    ...details,
  });
}
// END_BLOCK_INTERNAL_LOG

// START_BLOCK_DEFAULT_OS
function detectDefaultOS(): OSKind {
  if (isMobile()) {
    // Without a definitive mobile-OS signal we default to android limits (slightly safer than iOS).
    return "android";
  }
  if (typeof process !== "undefined" && typeof process.platform === "string") {
    switch (process.platform) {
      case "win32":
        return "win32";
      case "darwin":
        return "darwin";
      default:
        return "linux";
    }
  }
  return "linux";
}
// END_BLOCK_DEFAULT_OS

// START_CONTRACT: sanitizeComponent
// PURPOSE: scrub OS-invalid characters and trim oversized components
// INPUTS: component: string, os: OSKind
// OUTPUTS: string — sanitized path segment safe for the given OS
// SIDE_EFFECTS: none
// LINKS: UC-006, V-M-PATH-TEMPLATE
// END_CONTRACT: sanitizeComponent
export function sanitizeComponent(component: string, os: OSKind): string {
  // START_BLOCK_SANITIZE
  let cleaned = component.replace(INVALID_CHARS_RE, "_");
  // Strip control characters (0x00-0x1F).
  cleaned = cleaned.replace(/[\x00-\x1F]/g, "_");
  // Collapse runs of whitespace, then trim.
  cleaned = cleaned.replace(/\s+/g, " ").trim();
  // Windows additionally forbids trailing dots/spaces in components.
  cleaned = cleaned.replace(/[. ]+$/g, "");
  if (cleaned.length === 0) {
    cleaned = "_";
  }
  const limit = COMPONENT_LIMITS[os];
  if (cleaned.length > limit) {
    cleaned = cleaned.slice(0, limit);
  }
  return cleaned;
  // END_BLOCK_SANITIZE
}

// START_CONTRACT: renderPath
// PURPOSE: substitute placeholders into template, sanitize each path component
// INPUTS: template: string, vars: Record<string, string>, os?: OSKind
// OUTPUTS: string — final sanitized path
// SIDE_EFFECTS: emits PATH_RESOLVED log event; throws on unknown placeholder
// LINKS: UC-006, V-M-PATH-TEMPLATE
// END_CONTRACT: renderPath
export function renderPath(
  template: string,
  vars: Record<string, string>,
  os: OSKind = detectDefaultOS(),
): string {
  if (typeof template !== "string" || template.length === 0) {
    throw new Error("EMPTY_TEMPLATE");
  }

  // START_BLOCK_VALIDATE
  const validation = validateTemplate(template);
  if (!validation.valid) {
    throw new Error("UNKNOWN_PLACEHOLDER");
  }
  // END_BLOCK_VALIDATE

  // START_BLOCK_SUBSTITUTE
  // Split into components first so we can sanitize each one independently;
  // forward slashes inside `vars` values would otherwise inject extra segments.
  const rawComponents = template.split("/");
  const rendered = rawComponents.map((segment) => {
    const replaced = segment.replace(PLACEHOLDER_RE, (_match, key: string) => {
      const value = Object.prototype.hasOwnProperty.call(vars, key)
        ? vars[key]
        : "";
      return typeof value === "string" ? value : "";
    });
    return sanitizeComponent(replaced, os);
  });
  // END_BLOCK_SUBSTITUTE

  // START_BLOCK_FINALIZE
  let path = rendered.join("/");
  const fullLimit = FULL_PATH_LIMITS[os];
  if (path.length > fullLimit) {
    path = path.slice(0, fullLimit);
  }
  logInfo("renderPath:BLOCK_SANITIZE", "PATH_RESOLVED", "template rendered", {
    template,
    os,
    pathLength: path.length,
  });
  return path;
  // END_BLOCK_FINALIZE
}

// START_CONTRACT: validateTemplate
// PURPOSE: surface issues with a user-supplied template before saving
// INPUTS: template: string
// OUTPUTS: { valid: boolean; issues: string[] }
// SIDE_EFFECTS: emits TEMPLATE_INVALID log event when invalid
// LINKS: UC-006, V-M-PATH-TEMPLATE
// END_CONTRACT: validateTemplate
export function validateTemplate(template: string): {
  valid: boolean;
  issues: string[];
} {
  const issues: string[] = [];
  if (typeof template !== "string" || template.length === 0) {
    issues.push("EMPTY_TEMPLATE");
    logWarn("validateTemplate", "TEMPLATE_INVALID", "template missing/empty", {
      issues,
    });
    return { valid: false, issues };
  }
  const found = new Set<string>();
  // matchAll() is ES2020; the project lib is ES7, so we do the manual exec loop.
  const re = new RegExp(PLACEHOLDER_RE.source, PLACEHOLDER_RE.flags);
  let match: RegExpExecArray | null;
  while ((match = re.exec(template)) !== null) {
    const key = match[1];
    if (typeof key === "string") {
      found.add(key);
    }
  }
  for (const key of found) {
    if (!KNOWN_PLACEHOLDERS.includes(key)) {
      issues.push(`UNKNOWN_PLACEHOLDER:${key}`);
    }
  }
  const valid = issues.length === 0;
  if (!valid) {
    logWarn("validateTemplate", "TEMPLATE_INVALID", "unknown placeholders", {
      issues,
    });
  }
  return { valid, issues };
}

// START_CHANGE_SUMMARY
// LAST_CHANGE: 2026-05-13 — initial implementation per Phase 1 ⚠#11 hot spot
// END_CHANGE_SUMMARY
