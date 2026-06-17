// START_MODULE_CONTRACT
// MODULE: M-UNPACKER-WORKER
// PURPOSE: Web Worker for zstd decompression of article HTML. Uses @bokuweb/zstd-wasm with
// inline WASM binary (no fetch at runtime). Supports decompress simple and withDict.
// SCOPE: src/worker/unpacker.worker.ts
// DEPENDS: M-UNPACK-SERVICE
// ROLE: RUNTIME
// MAP_MODE: EXPORTS
// LINKS: UC-003, V-M-ARTICLE-BODY-LOADER
// END_MODULE_CONTRACT

// START_MODULE_MAP
// default - placeholder default export for test environments (production uses esbuild-plugin-inline-worker)
// END_MODULE_MAP

import { init, decompress, decompressUsingDict, createDCtx } from '@bokuweb/zstd-wasm';
import { wasmBase64 } from './wasm-base64';

const decoder = new TextDecoder('utf-8');

function wasmBytes(): Uint8Array {
  const binary = atob(wasmBase64);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

const stopper = new Set<string>();

// WASM init requires casting init to match runtime signature.
// The library types may not reflect the actual exported function shape.
(init as unknown as (bytes: Uint8Array) => Promise<void>)(wasmBytes()).then(() => {
  self.addEventListener('message', ({ data }) => {
    const id = data['id'] as string;
    const action = data['action'] as string;
    const fileData = data['fileData'] as Uint8Array;
    const dictData = data['dictData'] as Uint8Array | undefined;

    try {
      switch (action) {
        case 'simple':
          simpleUnpack(id, fileData);
          break;
        case 'withDict':
          withDictUnpack(id, fileData, dictData!);
          break;
        case 'stop':
          stopper.add(id);
          break;
      }
    } catch (e) {
      self.postMessage({ id, error: String(e) });
    }
  });
}).catch((reason: unknown) => console.error('zstd init failed', reason));

function mustStop(id: string): boolean {
  if (stopper.has(id)) {
    stopper.delete(id);
    self.postMessage({ id, stopped: true });
    return true;
  }
  return false;
}

function simpleUnpack(id: string, fileData: Uint8Array) {
  if (mustStop(id)) return;

  const resultArr = decompress(fileData);
  if (resultArr === null) {
    self.postMessage({ id, error: 'simpleUnpack returned null' });
    return;
  }

  if (mustStop(id)) return;
  const content = decoder.decode(resultArr);
  if (mustStop(id)) return;
  self.postMessage({ id, content });
}

function withDictUnpack(id: string, fileData: Uint8Array, dictData: Uint8Array) {
  if (mustStop(id)) return;

  const resultArr = decompressUsingDict(createDCtx(), fileData, dictData);
  if (resultArr === null) {
    self.postMessage({ id, error: 'withDictUnpack returned null' });
    return;
  }

  if (mustStop(id)) return;
  const content = decoder.decode(resultArr);
  if (mustStop(id)) return;
  self.postMessage({ id, content });
}

// Placeholder default export for test environments.
// In production, esbuild-plugin-inline-worker intercepts this import and provides
// a Worker constructor function — the actual export is never used at runtime.
export default null;

// START_CHANGE_SUMMARY
// LAST_CHANGE: 2026-05-27 — adapted for Obsidian plugin: inline WASM via base64, TextDecoder, no Angular deps
// END_CHANGE_SUMMARY
