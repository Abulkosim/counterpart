import { parentPort } from "node:worker_threads";
import { prepare } from "./answer.ts";

// The thread that offload.ts starts. It reads one share at a time, in the
// order asked, and sends back the material or the error's message.
parentPort!.on("message", (m: { id: number; home: string; contact: { name: string; rootKey: string }; owner: string; query: string }) => {
  try {
    parentPort!.postMessage({ id: m.id, value: prepare(m.home, m.contact, m.owner, m.query) });
  } catch (e) {
    parentPort!.postMessage({ id: m.id, error: (e as Error).message ?? String(e) });
  }
});
