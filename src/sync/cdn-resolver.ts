// START_MODULE_CONTRACT
// PURPOSE: Resolve CDN file paths from CdnStrategy (returned by apiFeedSync).
// Supports Static and Random server selection, article/dictionary/previewImage file types.
// SCOPE: src/sync/cdn-resolver.ts
// DEPENDS: none (pure functions; CdnStrategy types from NSwag generated client)
// LINKS: UC-003
// ROLE: RUNTIME
// MAP_MODE: EXPORTS
// END_MODULE_CONTRACT

// START_MODULE_MAP
// FileType - union of file types served by CDN
// CdnStrategyLike - structural slice of the generated CdnStrategy
// resolveCdnUrlCandidates - return ordered list of CDN URLs to try (all servers)
// END_MODULE_MAP

import {
  CdnFilenameStrategy,
  CdnOrderStrategy,
  type CdnConfig,
  type CdnStrategy,
} from "../api/clientV1_0";

// START_BLOCK_TYPES
export type FileType = "article" | "dictionary" | "previewImage";

/**
 * Structural slice of the generated CdnStrategy — we only consume the fields
 * needed for URL resolution, avoiding the full class surface (init/toJSON).
 */
export interface CdnStrategyLike {
  orderStrategy?: CdnOrderStrategy;
  filenameStrategy?: CdnFilenameStrategy;
  configs?: CdnConfig[] | undefined;
}
// END_BLOCK_TYPES

// START_CONTRACT: resolveCdnUrlCandidates
// PURPOSE: return ordered list of CDN URLs to try for a given fileId + type.
// Static → original config order; Random → shuffled. When `exclude` is given,
// already-tried URLs are filtered out. For Static, if all URLs are excluded
// the full list is returned (wrap-around). For Random, shuffle remaining URLs;
// if all tried, shuffle and return full list.
// INPUTS: strategy: CdnStrategyLike | null | undefined, fileId: string, fileType: FileType, exclude?: string[]
// OUTPUTS: string[] — empty when config is missing/invalid
// SIDE_EFFECTS: none (pure function)
// LINKS: UC-003
// END_CONTRACT: resolveCdnUrlCandidates
function buildCdnUrl(base: string, fileId: string, fileType: FileType): string {
  switch (fileType) {
    case "article":
    case "previewImage":
      return `${base}/${fileId.slice(1, 3)}/${fileId}`;
    case "dictionary":
      return `${base}/_d/${fileId}`;
    default:
      return "";
  }
}

function buildUrls(servers: CdnConfig[], fileId: string, fileType: FileType): string[] {
  const urls: string[] = [];
  for (const server of servers) {
    if (!server?.url) continue;
    const base = server.url.replace(/\/+$/, "");
    const url = buildCdnUrl(base, fileId, fileType);
    if (url) urls.push(url);
  }
  return urls;
}

export function resolveCdnUrlCandidates(
  strategy: CdnStrategyLike | null | undefined,
  fileId: string,
  fileType: FileType,
  exclude?: string[],
): string[] {
  // START_BLOCK_VALIDATE
  if (!strategy?.configs?.length) return [];
  if (!strategy.filenameStrategy) return [];
  if (!strategy.orderStrategy) return [];
  // END_BLOCK_VALIDATE

  // START_BLOCK_SELECT_SERVERS
  let servers = [...strategy.configs];
  if (strategy.orderStrategy === CdnOrderStrategy.Random) {
    servers = servers.sort(() => 0.5 - Math.random());
  }
  // END_BLOCK_SELECT_SERVERS

  // START_BLOCK_BUILD_PATHS
  let urls = buildUrls(servers, fileId, fileType);

  // START_BLOCK_EXCLUDE
  if (exclude?.length) {
    const included = urls.filter((u) => !exclude.includes(u));
    if (included.length === 0) {
      // All URLs were already tried — return full list for retry.
      // For Static this wraps around; for Random the URLs were already shuffled.
      return urls;
    }
    return included;
  }
  // END_BLOCK_EXCLUDE

  return urls;
  // END_BLOCK_BUILD_PATHS
}

// START_CHANGE_SUMMARY
// LAST_CHANGE: 2026-05-30 — initial implementation; extracted from adaptArticleSync
// LAST_CHANGE: 2026-06-04 — replace resolveCdnUrl with resolveCdnUrlCandidates (all configs); add buildCdnUrl helper
// LAST_CHANGE: 2026-06-04 — add `exclude` param for CDN retry; extract buildUrls helper; wrap-around for Static
// END_CHANGE_SUMMARY
