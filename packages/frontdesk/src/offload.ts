import { Worker } from "node:worker_threads";
import type { Contact, Material } from "./answer.ts";

// Runs prepare() on a worker thread. Reading a large share runs Git, the
// secret scan and the ranking, which can take seconds; on the daemon's own
// thread that would stall the relay link too. One thread is kept while the
// desk is open, so its cache of scanned files lasts between answers. A read
// that takes longer than `timeoutMs` is abandoned and the thread is replaced.

interface Pending {
  resolve: (m: Material | null) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

export const PREPARE_TIMEOUT_MS = 90_000;

export class Preparer {
  private worker: Worker | null = null;
  private seq = 0;
  private pending = new Map<number, Pending>();
  private timeoutMs: number;

  constructor(opts: { timeoutMs?: number } = {}) {
    this.timeoutMs = opts.timeoutMs ?? PREPARE_TIMEOUT_MS;
  }

  run(home: string, contact: Contact, owner: string, query: string): Promise<Material | null> {
    const w = this.start();
    const id = ++this.seq;
    return new Promise<Material | null>((resolve, reject) => {
      const timer = setTimeout(() => this.fail(new Error(`reading what is shared took longer than ${Math.round(this.timeoutMs / 1000)} s`)), this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      w.ref();
      w.postMessage({ id, home, contact: { name: contact.name, rootKey: contact.rootKey }, owner, query });
    });
  }

  close(): void {
    this.fail(new Error("the front desk closed"));
  }

  private start(): Worker {
    if (this.worker) return this.worker;
    const w = new Worker(new URL("./prepare-worker.ts", import.meta.url));
    w.on("message", (m: { id: number; value?: Material | null; error?: string }) => {
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      clearTimeout(p.timer);
      if (this.pending.size === 0) w.unref();
      if (m.error !== undefined) p.reject(new Error(m.error));
      else p.resolve(m.value ?? null);
    });
    w.on("error", (e) => this.fail(e));
    w.on("exit", () => {
      if (this.worker === w) this.fail(new Error("the share reader stopped"));
    });
    w.unref();
    this.worker = w;
    return w;
  }

  // Every waiting read fails and the thread is dropped; the next read starts a new one.
  private fail(e: Error): void {
    const w = this.worker;
    this.worker = null;
    const all = [...this.pending.values()];
    this.pending.clear();
    for (const p of all) {
      clearTimeout(p.timer);
      p.reject(e);
    }
    if (w) void w.terminate();
  }
}
