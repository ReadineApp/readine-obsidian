// START_MODULE_CONTRACT
// MODULE: M-PLATFORM-UNPACKER
// PURPOSE: Capacitor plugin facade for the native 'Unpacker' bridge (Android implementation in capacitor-android). Declares IUnpackerPlugin with a single echo(options) method that dispatches base64-encoded payloads to native and resolves with {reqId, unpacked, error}. Default-exported via registerPlugin<IUnpackerPlugin>('Unpacker').
// SCOPE: src/app/platform-specific/unpacker/UnpackerPlugin.ts (file-level slice of M-PLATFORM-UNPACKER)
// DEPENDS: M-CORE-ERROR-PIPELINE, M-PERSIST-UNPACKER
// ROLE: TYPES
// MAP_MODE: EXPORTS
// CRITICALITY: standard
// LINKS: V-M-PLATFORM-UNPACKER
// END_MODULE_CONTRACT

// START_MODULE_MAP
// IUnpackerPlugin - Capacitor plugin contract: echo({reqId, action, articleDataBase64, dictDataBase64, imageDataBase64}) -> {reqId, unpacked, error}
// default - registerPlugin<IUnpackerPlugin>('Unpacker') singleton (named `Unpacker` in source) consumed by UnpackServiceCapacitor
// END_MODULE_MAP

import {registerPlugin} from '@capacitor/core';

export interface IUnpackerPlugin {
  echo(options: {
    reqId: string,
    action: "article" | "image",
    articleDataBase64: string,
    dictDataBase64: string,
    imageDataBase64: string,
  }): Promise<{
    reqId: string,
    unpacked: string,
    error: string | null | undefined
  }>;
}

const Unpacker = registerPlugin<IUnpackerPlugin>('Unpacker');

export default Unpacker;

// START_CHANGE_SUMMARY
// LAST_CHANGE: 2026-05-06 — doubled-graph migration markup added (no behavior changes)
// END_CHANGE_SUMMARY
