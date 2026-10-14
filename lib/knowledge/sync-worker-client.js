const path = require('node:path');
const { Worker } = require('node:worker_threads');

class SyncWorker {
  constructor(filename = 'sync-worker.js') { this.filename = filename; this.worker = null; this.requests = new Map(); this.nextId = 0; }
  request(type, payload) {
    if (!this.worker) {
      // Node's worker bootstrap must receive a real file in packaged Electron.
      const filename = path.join(__dirname, this.filename).replace(/([\\/])app\.asar([\\/])/, '$1app.asar.unpacked$2');
      const worker = new Worker(filename);
      this.worker = worker;
      worker.on('message', message => {
        const pending = this.requests.get(message.id);
        if (!pending) return;
        this.requests.delete(message.id);
        if (message.error) pending.reject(Object.assign(new Error(message.error), { code: message.code }));
        else pending.resolve(message.result);
        if (!this.requests.size) worker.unref();
      });
      const fail = error => {
        if (this.worker !== worker) return;
        this.worker = null;
        for (const pending of this.requests.values()) pending.reject(error);
        this.requests.clear();
      };
      worker.on('error', fail);
      worker.on('exit', code => fail(new Error(`同步后台任务已停止 (${code})`)));
      worker.unref();
    }
    this.worker.ref();
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      this.requests.set(id, { resolve, reject });
      this.worker.postMessage({ id, type, payload });
    });
  }
  async stop() {
    const worker = this.worker;
    this.worker = null;
    for (const pending of this.requests.values()) pending.reject(Object.assign(new Error('同步任务已取消'), { code: 'SYNC_CANCELLED' }));
    this.requests.clear();
    if (worker) await worker.terminate();
  }
}
module.exports = { SyncWorker };
