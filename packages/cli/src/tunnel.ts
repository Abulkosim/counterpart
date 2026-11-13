// A public address for a relay on this machine, through a cloudflared quick
// tunnel. No account is needed. The address lasts as long as the process.
import { spawn } from "node:child_process";

export function openTunnel(port: number): Promise<{ url: string; close(): void }> {
  return new Promise((resolve, reject) => {
    const child = spawn("cloudflared", ["tunnel", "--no-autoupdate", "--url", `http://127.0.0.1:${port}`], { stdio: ["ignore", "ignore", "pipe"] });
    let seen = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`cloudflared gave no address in 40 seconds. It said:\n${seen.slice(-600)}`));
    }, 40_000);
    child.on("error", (e: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      reject(new Error(e.code === "ENOENT" ? "--tunnel needs cloudflared on your PATH. Get it from https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/" : e.message));
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`cloudflared stopped (exit ${code}). It said:\n${seen.slice(-600)}`));
    });
    child.stderr.on("data", (d: Buffer) => {
      seen += d.toString("utf8");
      const m = /https:\/\/([a-z0-9-]+\.trycloudflare\.com)/.exec(seen);
      if (!m) return;
      clearTimeout(timer);
      child.removeAllListeners("exit");
      child.on("exit", () => {
        console.error("cloudflared stopped; the public address is gone. Stopping the relay.");
        process.kill(process.pid, "SIGTERM");
      });
      resolve({ url: `wss://${m[1]}`, close: () => child.kill() });
    });
  });
}
