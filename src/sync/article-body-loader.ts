// START_MODULE_CONTRACT
// PURPOSE: Load article HTML body from CDN. Two paths: A (local cache for dictionaries),
// B (HTTP download from CDN). Downloads zstd-compressed binary, decompresses via UnpackService,
// caches dictionary files for reuse across articles.
// SCOPE: src/sync/article-body-loader.ts
// DEPENDS: M-UNPACK-SERVICE, M-VAULT-FILE-STORAGE
// LINKS: UC-003, V-M-ARTICLE-BODY-LOADER
// ROLE: RUNTIME
// END_MODULE_CONTRACT

// START_MODULE_MAP
// ArticleBodyLoaderDeps - DI bag
// ArticleBodyLoader - class: load(articleId, dictionaryId?, cdn?) → Promise<string>
// END_MODULE_MAP

import { requestUrl } from "obsidian";
import type { VaultFileStorage } from "../storage/vault-file-storage";
import { UnpackService } from "./unpack-service";
import { resolveCdnUrlCandidates, type CdnStrategyLike } from "./cdn-resolver";

// START_BLOCK_TYPES
export interface ArticleBodyLoaderDeps {
  storage: VaultFileStorage;
  unpackService: UnpackService;
  /** Cache base path relative to vault (e.g. ".obsidian/readine/cache/dictionaries"). */
  dictCachePath?: string;
}
// END_BLOCK_TYPES

// START_CONTRACT: ArticleBodyLoader
// PURPOSE: download zstd-compressed article body from CDN and decompress to HTML
// INPUTS: articleId, dictionaryId?, cdn config
// OUTPUTS: Promise<string> — decompressed HTML
// SIDE_EFFECTS: HTTP requests to CDN; writes dictionary cache to vault
// LINKS: UC-003, V-M-ARTICLE-BODY-LOADER
// END_CONTRACT: ArticleBodyLoader
export class ArticleBodyLoader {
  private readonly storage: VaultFileStorage;
  private readonly unpackService: UnpackService;
  private readonly dictCachePath: string;

  constructor(deps: ArticleBodyLoaderDeps) {
    this.storage = deps.storage;
    this.unpackService = deps.unpackService;
    this.dictCachePath = deps.dictCachePath ?? ".obsidian/plugins/readine-sync/cache/dictionaries";
  }

  // START_CONTRACT: load
  // PURPOSE: full flow — get article body (CDN), decompress (zstd), return HTML
  // INPUTS: articleId: string, dictionaryId: string, cdn: CdnStrategyLike | null
  // OUTPUTS: Promise<string | null> — HTML string, or null when all CDN servers failed
  // SIDE_EFFECTS: HTTP requests; writes dictionary cache
  // LINKS: UC-003, V-M-ARTICLE-BODY-LOADER
  // END_CONTRACT: load
  async load(
    articleId: string,
    dictionaryId: string,
    cdn: CdnStrategyLike | null,
  ): Promise<string | null> {
    if (!articleId) throw new Error("Invalid articleId");
    if (!dictionaryId) throw new Error("Invalid dictionaryId");

    // START_BLOCK_CDN_ITERATE
    const candidates = resolveCdnUrlCandidates(cdn, articleId, "article");
    if (candidates.length === 0) return null;

    let bodyBuf: Uint8Array | undefined;
    for (const bodyUrl of candidates) {
      const bodyRes = await requestUrl({ url: bodyUrl, method: "GET", throw: false });
      if (bodyRes.status === 200 && bodyRes.arrayBuffer) {
        bodyBuf = new Uint8Array(bodyRes.arrayBuffer);
        break;
      }
    }
    if (!bodyBuf) {
      console.warn({
        ts: new Date().toISOString(),
        level: "warn",
        anchor: "load:BLOCK_CDN_ITERATE",
        module: "M-ARTICLE-BODY-LOADER",
        requirement: "UC-003",
        event: "CDN_FAILED",
        belief: "decompression failed — all CDN candidates exhausted",
        //error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
    // END_BLOCK_CDN_ITERATE

    // START_BLOCK_DICTIONARY
    let dictBuf: Uint8Array | undefined;
    if (dictionaryId) {
      dictBuf = await this._loadDictionary(dictionaryId, cdn);
    }
    // END_BLOCK_DICTIONARY

    // START_BLOCK_DECOMPRESS
    try {
      return await this.unpackService.unpack(articleId, bodyBuf, dictBuf);
    } catch (err) {
      console.warn({
        ts: new Date().toISOString(),
        level: "warn",
        anchor: "ArticleBodyLoader:BLOCK_DECOMPRESS",
        module: "M-ARTICLE-BODY-LOADER",
        requirement: "UC-003",
        event: "BODY_DECOMPRESS_FAILED",
        belief: "decompression failed",
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
    // END_BLOCK_DECOMPRESS
  }

  // START_CONTRACT: _loadDictionary
  // PURPOSE: Path A — check vault cache, fallback to CDN download (all candidates)
  // INPUTS: dictionaryId, cdn
  // OUTPUTS: Promise<Uint8Array | undefined>
  // SIDE_EFFECTS: writes dictionary to vault cache if downloaded
  // LINKS: UC-003
  // END_CONTRACT: _loadDictionary
  private async _loadDictionary(
    dictionaryId: string,
    cdn: CdnStrategyLike | null,
  ): Promise<Uint8Array | undefined> {
    // Check cache first
    const cachePath = `${this.dictCachePath}/${dictionaryId}`;
    try {
      const cached = await this.storage.readBinary(cachePath);
      if (cached && cached.byteLength > 0) {
        return new Uint8Array(cached);
      }
    } catch {
      // Cache miss — download
    }

    // Try all CDN candidates for dictionary
    const candidates = resolveCdnUrlCandidates(cdn, dictionaryId, "dictionary");
    for (const dictUrl of candidates) {
      const dictRes = await requestUrl({ url: dictUrl, method: "GET", throw: false });
      if (dictRes.status === 200 && dictRes.arrayBuffer) {
        const dictBuf = new Uint8Array(dictRes.arrayBuffer);

        // Write to cache (fire-and-forget)
        try {
          await this.storage.write(cachePath, dictRes.arrayBuffer);
        } catch (err) {
          console.warn("[ArticleBodyLoader] dict cache write failed", err);
        }

        return dictBuf;
      }
    }

    return undefined;
  }

  // START_CONTRACT: clearDictCache
  // PURPOSE: remove all cached dictionary files
  // INPUTS: none
  // OUTPUTS: Promise<void>
  // LINKS: V-M-ARTICLE-BODY-LOADER
  // END_CONTRACT: clearDictCache
  async clearDictCache(): Promise<void> {
    try {
      const base = this.dictCachePath;
      if (await this.storage.exists(base)) {
        await this.storage.remove(base);
      }
    } catch { /* best-effort */ }
  }
}

// START_CHANGE_SUMMARY
// LAST_CHANGE: 2026-05-30 — use resolveCdnUrl for CDN path resolution; accept CdnStrategyLike
// LAST_CHANGE: 2026-06-04 — iterate all CDN candidates via resolveCdnUrlCandidates; return null on all fail
// LAST_CHANGE: 2026-06-07 — change default dictCachePath from .obsidian/ to .obsidian/plugins/
// LAST_CHANGE: 2026-06-07 — fix dictionary cache corruption: use readBinary instead of read to preserve binary integrity (zstd error -32)
// END_CHANGE_SUMMARY
