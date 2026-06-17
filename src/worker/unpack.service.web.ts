// START_MODULE_CONTRACT
// MODULE: M-PLATFORM-UNPACKER
// PURPOSE: IUnpacker implementation for web (also used as the iOS fallback for small articles). Spawns a single Web Worker hosting @bokuweb/zstd-wasm; transfers Uint8Array buffers to the worker (transfer-list), keys callbacks by reqId, and supports a 'wasStopped' marker to drop in-flight image jobs. Throttles image work to ≤20 concurrent via a 300 ms timer that drains the queue. Registers the worker with ErrorHandlerService for crash propagation.
// SCOPE: src/app/platform-specific/unpacker/unpack.service.web.ts (file-level slice of M-PLATFORM-UNPACKER)
// DEPENDS: M-CORE-ERROR-PIPELINE, M-PERSIST-UNPACKER
// ROLE: RUNTIME
// MAP_MODE: SUMMARY
// CRITICALITY: standard
// LINKS: V-M-PLATFORM-UNPACKER
// END_MODULE_CONTRACT

// START_MODULE_MAP
// UnpackServiceWeb - @Injectable({providedIn:'root'}) IUnpacker impl driving a zstd-wasm Web Worker (./unpacker.worker)
// Public surface: UnpackArticle (postMessage {action: 'simple' | 'withDict', fileData[, dictData]} with transfer list), UnpackImage (enqueue then call tryNextTick — gates concurrency to 20 active jobs), StopUnpackImage (filters the queue; intentionally does NOT cancel in-flight jobs because of an F5 blink bug — kept as inline comment)
// Lifecycle: ctor instantiates Worker(new URL('./unpacker.worker', import.meta.url)) and registers it with ErrorHandlerService.RegisterWorker('zip', worker); ngOnDestroy clears the timer and terminates the worker
// Private state: callbacks (keyed by reqId), counter (active jobs), queueImages (pending image work), 300 ms timer that calls tryNextTick 10× per tick
// Private constants: wasStopped marker string used for cooperative cancellation
// END_MODULE_MAP

import {Injectable} from '@angular/core';
import {OnDestroy} from '@angular/core';
import {IUnpacker} from './iunpacker';
import {ErrorHandlerService} from '../../services/error.handler.service';

const wasStopped = 'wasStopped_65234rwe3d1a_marker';

@Injectable({
  providedIn: 'root'
})
export class UnpackServiceWeb implements OnDestroy, IUnpacker {
  private worker: Worker;
  private callbacks: { [id: string]: (message: string) => void } = {};
  private counter: number = 0;
  private queueImages: { imageId: string, fileData: Uint8Array }[] = [];
  private timer = setInterval(() => {
      for (let i = 0; i < 10; i++) this.tryNextTick()
    },
    300);


  constructor(
    private errorHandlerService: ErrorHandlerService,
  ) {
    // console.log("ctor UnpackService");

    // this.worker = new Worker(new URL('./unpacker.worker', import.meta.url), {type: 'module'});
    this.worker = new Worker(new URL('./unpacker.worker', import.meta.url));
    this.errorHandlerService.RegisterWorker('zip', this.worker);

    this.worker.onmessage = (msg) => {
      // console.log('worker', msg.data);
      this.processCallback(msg.data);
    }
  }

  ngOnDestroy(): void {
    delete this.timer;
    this.worker.terminate();
  }

  private addCallback(reqId: string, cb: (message) => void) {
    // console.log('add callback for', reqId);
    this.callbacks[reqId] = cb;
  }

  private processCallback(message: any) {
    const reqId = message["id"];
    const content = message["content"];
    const error = message["error"];
    if (error) {
      console.error('unpacking is failed', error);
    } else {
      const cb = this.callbacks[reqId];
      if (cb === undefined) return;
      this.counter--;
      if (message["stopped"]) {
        cb(wasStopped);
      } else {
        cb(content);
      }

    }
    delete this.callbacks[reqId];
  }

  public UnpackImage(imageId: string, fileData: Uint8Array): Promise<string> {
    if (!fileData) {
      return Promise.reject('empty data');
    }

    const promise = new Promise<string>((resolve, reject) => {
      this.addCallback(imageId, (message) => {
        if (message) {
          if (message == wasStopped) {
            // reject('stop unpacking image ' + imageId);
            resolve(null);
          } else
            resolve(message);
        } else {
          reject('wrong result after unpacking image ' + imageId);
        }
      });
    });

    this.queueImages.push({imageId, fileData});
    this.tryNextTick();

    return promise;
  }

  private tryNextTick(): void {
    if (this.counter < 20) {
      let item = this.queueImages.shift();
      if (item == undefined)
        return;
      this.counter++;
      this.worker.postMessage({
        id: item.imageId,
        action: "image",
        fileData: item.fileData
      }, [item.fileData.buffer]);
    }
  }

  public UnpackArticle(articleId: string, articleFileData: Uint8Array, dictionaryFileData: Uint8Array | null): Promise<string> {
    if (!articleFileData) {
      return Promise.reject('empty data');
    }

    const promise = new Promise<string>((resolve, reject) => {
      this.addCallback(articleId, (message) => {
        if (message) {
          if (message == wasStopped) {
            // reject('stop unpacking article ' + articleId);
            resolve(null);
          } else
            resolve(message);
        } else {
          reject('wrong result after unpacking article ' + articleId);
        }
      });
    });

    if (dictionaryFileData) {
      // console.log('UnpackService withDict', articleId, ' -> ', articleFileData.buffer.byteLength, dictionaryFileData.buffer.byteLength);
      this.worker.postMessage({
        id: articleId,
        action: 'withDict',
        fileData: articleFileData,
        dictData: dictionaryFileData,
      }, [articleFileData.buffer, dictionaryFileData.buffer]);
    } else {
      // console.log('UnpackService simple', articleId,' -> ', articleFileData.length);
      this.worker.postMessage({
        id: articleId,
        action: 'simple',
        fileData: articleFileData,
      }, [articleFileData.buffer]);
    }

    return promise;
  }

  /// increase performance
  public StopUnpackImage(itemId: string) {
    this.queueImages = this.queueImages.filter(function (item) {
      return item.imageId !== itemId;
    })
    return; //bug with F5, it blinks and second draw make stop

    // if(!itemId) return;
    // this.worker.postMessage({
    //   id: itemId,
    //   action: "stop"
    // });
  }
}

// START_CHANGE_SUMMARY
// LAST_CHANGE: 2026-05-06 — doubled-graph migration markup added (no behavior changes)
// END_CHANGE_SUMMARY
