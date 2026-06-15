// START_MODULE_CONTRACT
// PURPOSE: Shared types for Phase 5 sync primitives. Article shape (re-exported from M-VAULT-WRITER's ReadineArticle so the format is consistent end-to-end). Decouples sync modules from the wide NSwag-generated Client_V1_0 surface.
// SCOPE: src/sync/types.ts
// DEPENDS: M-VAULT-WRITER
// LINKS: UC-003, UC-016, UC-017, V-M-SYNC-ARTICLES, V-M-SYNC-FILES
// ROLE: TYPES
// MAP_MODE: EXPORTS
// END_MODULE_CONTRACT

// START_MODULE_MAP
// Article - re-export of ReadineArticle (canonical article shape consumed by M-VAULT-WRITER); surfaced as 'Article' for grep symmetry with reference draft/.
// END_MODULE_MAP

import type { ReadineArticle } from "../vault/vault-writer";

// START_BLOCK_TYPES
/**
 * Canonical article shape passed through the sync pipeline.
 *
 * Re-exported from M-VAULT-WRITER's ReadineArticle so M-SYNC-ARTICLES /
 * M-SYNC-FILES can hand the same value straight to VaultWriter.writeArticle()
 * without an adapter layer. The reference draft/ refers to this as just
 * `Article`; we keep both aliases live for grep symmetry.
 */
export type Article = ReadineArticle;
// END_BLOCK_TYPES

// START_CHANGE_SUMMARY
// LAST_CHANGE: 2026-05-31 — remove ArticleDelta, ReadineApi, and Attachment types
// END_CHANGE_SUMMARY
