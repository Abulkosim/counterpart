// A TCP proxy that can black-hole traffic without closing anything: what a
// laptop sees when Wi-Fi drops or a NAT forgets the flow. Bytes stop moving in
// both directions, sockets stay open, new connections are accepted and hang.
//
// As a program: node scripts/tcp-proxy.ts <listen host> <listen port> <target host> <target port>
//   SIGUSR1 black-holes, SIGUSR2 lets traffic through again. It prints each change.
import { type Server, type Socket, createConnection, createServer } from "node:net";

export interface Proxy {
  port: number;
  server: Server;
  blackhole(on: boolean): void;
  // Drop every connection at once, as a router reboot would.
  reset(): void;
  close(): Promise<void>;
}

export function startProxy(opts: { host?: string; port?: number; targetHost?: string; targetPort: number | (() => number) }): Promise<Proxy> {
  let holed = false;
  const pairs = new Set<{ a: Socket; b: Socket }>();
  const target = (): number => (typeof opts.targetPort === "function" ? opts.targetPort() : opts.targetPort);
  const server = createServer((a) => {
    a.on("error", () => {});
    const b = createConnection({ host: opts.targetHost ?? "127.0.0.1", port: target() });
    b.on("error", () => a.destroy());
    a.on("error", () => b.destroy());
    a.on("close", () => b.destroy());
    b.on("close", () => a.destroy());
    const pair = { a, b };
    pairs.add(pair);
    a.on("close", () => pairs.delete(pair));
    // Data that arrives while black-holed is read and thrown away, so nothing
    // backs up and nothing tells either end.
    a.on("data", (d) => void (holed || b.write(d)));
    b.on("data", (d) => void (holed || a.write(d)));
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port ?? 0, opts.host ?? "127.0.0.1", () => {
      server.off("error", reject);
      resolve({
        port: (server.address() as { port: number }).port,
        server,
        blackhole: (on) => void (holed = on),
        reset() {
          for (const p of pairs) {
            p.a.destroy();
            p.b.destroy();
          }
        },
        close: () =>
          new Promise<void>((r) => {
            for (const p of pairs) {
              p.a.destroy();
              p.b.destroy();
            }
            server.close(() => r());
          }),
      });
    });
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [host, port, targetHost, targetPort] = process.argv.slice(2);
  if (!host || !port || !targetHost || !targetPort) {
    console.error("usage: node scripts/tcp-proxy.ts <listen host> <listen port> <target host> <target port>");
    process.exit(2);
  }
  const p = await startProxy({ host, port: Number(port), targetHost, targetPort: Number(targetPort) });
  const stamp = (): string => new Date().toISOString();
  console.log(`${stamp()} proxy ${host}:${p.port} -> ${targetHost}:${targetPort}`);
  process.on("SIGUSR1", () => {
    p.blackhole(true);
    console.log(`${stamp()} black-holed`);
  });
  process.on("SIGUSR2", () => {
    p.blackhole(false);
    console.log(`${stamp()} passing traffic`);
  });
  process.on("SIGTERM", () => void p.close().then(() => process.exit(0)));
}
