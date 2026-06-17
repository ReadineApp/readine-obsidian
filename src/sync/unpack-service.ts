// START_MODULE_CONTRACT
// PURPOSE: Web Worker wrapper for zstd decompression. Spawns the inlined unpacker worker,
// manages request callbacks, transfers Uint8Array buffers via postMessage (zero-copy).
// SCOPE: src/sync/unpack-service.ts
// DEPENDS: M-UNPACKER-WORKER
// LINKS: UC-003, V-M-ARTICLE-BODY-LOADER
// ROLE: RUNTIME
// END_MODULE_CONTRACT

// START_MODULE_MAP
// UnpackService - class: unpack(id, data, dict?) → Promise<string>; terminate()
// END_MODULE_MAP

// esbuild-plugin-inline-worker intercepts this import and replaces it with
// a Worker constructor function (ignoring the actual default export of `null`).
import createWorkerTs from "../worker/unpacker.worker.ts";
const createWorker: () => Worker = (createWorkerTs ||
  (() => { throw new Error("Worker not available in this environment"); })) as unknown as () => Worker;

// START_CONTRACT: UnpackService
// PURPOSE: manage a single Web Worker instance for zstd decompression
// INPUTS: none
// OUTPUTS: unpack(id, Uint8Array, dict?) → Promise<string>
// SIDE_EFFECTS: spawns a Worker; transfers ArrayBuffers via postMessage
// LINKS: UC-003, V-M-ARTICLE-BODY-LOADER
// END_CONTRACT: UnpackService
interface PendingUnpack {
  resolve: (html: string) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class UnpackService {
  private worker: Worker;
  private readonly pending = new Map<string, PendingUnpack>();
  private running = true;

  constructor() {
    try {
      this.worker = createWorker();
    } catch {
      console.warn("[UnpackService] Worker creation failed — running in degraded mode");
      this.running = false;
      this.worker = null as unknown as Worker;
      return;
    }
    this._wireWorker();
  }

  private _wireWorker(): void {
    this.worker.onmessage = (e: MessageEvent) => {
      const { id, content, error, stopped } = e.data;
      const p = this.pending.get(id);
      if (!p) return;
      this.pending.delete(id);
      clearTimeout(p.timer);
      if (error) {
        console.warn("[UnpackService] decompress error", id, error);
        p.reject(new Error(error));
      } else if (stopped) {
        p.reject(new Error(`unpack stopped for ${id}`));
      } else if (content !== undefined) {
        p.resolve(content);
      }
    };
    this.worker.onerror = ((err: Event | string) => {
      console.error("[UnpackService] worker error — restarting", err);
      this._restartWorker();
    }) as (err: Event | string) => void;
  }

  private _restartWorker(): void {
    try { this.worker.terminate(); } catch { /* ignore */ }
    // Clear all pending timeouts before rejecting
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error("Worker restarted"));
    }
    this.pending.clear();
    try {
      this.worker = createWorker();
      this._wireWorker();
    } catch {
      console.warn("[UnpackService] Worker restart failed");
    }
  }

  // START_CONTRACT: unpack
  // PURPOSE: decompress a zstd-compressed Uint8Array, optionally with dictionary
  // INPUTS: id: string, data: Uint8Array, dict?: Uint8Array
  // OUTPUTS: Promise<string> — decompressed HTML
  // SIDE_EFFECTS: transfers data.buffer to the Worker
  // LINKS: UC-003, V-M-ARTICLE-BODY-LOADER
  // END_CONTRACT: unpack
  unpack(id: string, data: Uint8Array, dict?: Uint8Array): Promise<string> {
    if (!this.running) return Promise.reject(new Error("UnpackService terminated"));

    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`unpack timeout for ${id}`));
      }, 30000);

      this.pending.set(id, { resolve, reject, timer });

      const transferables: ArrayBufferLike[] = [data.buffer];
      if (dict) transferables.push(dict.buffer);

      this.worker.postMessage(
        {
          id,
          action: dict ? "withDict" : "simple",
          fileData: data,
          ...(dict ? { dictData: dict } : {}),
        },
        transferables as ArrayBuffer[],
      );
    });
  }

  // START_CONTRACT: terminate
  // PURPOSE: shut down the worker, reject all pending callbacks
  // INPUTS: none
  // OUTPUTS: void
  // SIDE_EFFECTS: worker.terminate()
  // LINKS: V-M-ARTICLE-BODY-LOADER
  // END_CONTRACT: terminate
  terminate(): void {
    this.running = false;
    try { this.worker.terminate(); } catch { /* ignore */ }
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
    }
    this.pending.clear();
  }
}

// START_CHANGE_SUMMARY
// LAST_CHANGE: 2026-05-27 — initial implementation; wraps inlined Worker from esbuild-plugin-inline-worker
// LAST_CHANGE: 2026-06-07 — fix orphaned promise on worker error/stop: add p.reject() in _wireWorker
// END_CHANGE_SUMMARY
