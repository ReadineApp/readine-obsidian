// START_MODULE_CONTRACT
// MODULE: M-PLATFORM-UNPACKER
// PURPOSE: DI token + IUnpacker contract for zstd decompression of article HTML and preview images. Implementations are runtime-bound by PlatformSpecificModule (Capacitor native plugin on Android, Electron IPC bridge to native zstd on desktop, @bokuweb/zstd-wasm web worker on PWA + iOS).
// SCOPE: src/app/platform-specific/unpacker/iunpacker.ts (file-level slice of M-PLATFORM-UNPACKER)
// DEPENDS: M-CORE-ERROR-PIPELINE, M-PERSIST-UNPACKER
// ROLE: TYPES
// MAP_MODE: EXPORTS
// CRITICALITY: standard
// LINKS: V-M-PLATFORM-UNPACKER
// END_MODULE_CONTRACT

// START_MODULE_MAP
// IUnpackerToken - InjectionToken for IUnpacker
// IUnpacker - contract: UnpackArticle (with optional dictionary), UnpackImage, StopUnpackImage (to drop pending image jobs and free the worker queue)
// END_MODULE_MAP

import {InjectionToken} from '@angular/core';

export const IUnpackerToken = new InjectionToken('IUnpackerToken');

export interface IUnpacker {

  UnpackArticle(articleId: string, articleFileData: Uint8Array, dictionaryFileData: Uint8Array | null): Promise<string>;

  UnpackImage(imageId: string, fileData: Uint8Array): Promise<string>;
  /// increase performance
  StopUnpackImage(itemId: string);
}

// START_CHANGE_SUMMARY
// LAST_CHANGE: 2026-05-06 — doubled-graph migration markup added (no behavior changes)
// END_CHANGE_SUMMARY
