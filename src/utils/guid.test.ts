// START_MODULE_CONTRACT
// PURPOSE: Tests for generateGuid — UUID v4-like format and uniqueness
// SCOPE: src/utils/guid.test.ts
// DEPENDS: M-CORE-UTILS
// LINKS: UC-003, UC-022
// ROLE: TEST
// END_MODULE_CONTRACT

// START_MODULE_MAP
// (test file — no public exports)
// END_MODULE_MAP

import { describe, expect, it } from "vitest";
import { generateGuid } from "./guid";

describe("generateGuid", () => {
  const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

  it("returns a valid UUID v4-like string", () => {
    const guid = generateGuid();
    expect(guid).toMatch(uuidRe);
  });

  it("returns unique values on each call", () => {
    const guids = new Set<string>();
    for (let i = 0; i < 100; i++) {
      guids.add(generateGuid());
    }
    expect(guids.size).toBe(100);
  });
});

// START_CHANGE_SUMMARY
// LAST_CHANGE: 2026-06-04 — initial test file for generateGuid
// END_CHANGE_SUMMARY
