#!/usr/bin/env node
// Draws the demo video from the recorded tape: opens video.html, steps time
// frame by frame, and pipes screenshots to ffmpeg.
//
//   TESTS=<n> node demo/render.mjs                 the whole video -> demo/out/counterpart-demo.mp4
//   TESTS=<n> node demo/render.mjs --stills 3,20   PNG stills at those seconds, to look at
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ffmpeg from "ffmpeg-static";
import { chromium } from "playwright";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "out");
const FPS = 30;
const tape = JSON.parse(readFileSync(join(OUT, "tape.json"), "utf8"));
const meta = JSON.parse(tape.find((e) => e.scene === "meta").out);
// The numbers on the last card come from docs/gauntlet.md and from TESTS, the
// count `pnpm test` printed for the same commit. A number that cannot be read
// stops the render rather than showing a guess.
const gauntlet = readFileSync(join(HERE, "../docs/gauntlet.md"), "utf8");
const total = /\|\s*\**All\**\s*\|\s*\**(\d+)\**\s*\|\s*\**(\d+)\**/i.exec(gauntlet);
const model = /(\d+) of \d+ attacks never worked/.exec(gauntlet);
if (!total || !model) throw new Error("docs/gauntlet.md no longer has the totals this reads");
if (!/^\d+$/.test(process.env.TESTS ?? "")) throw new Error("set TESTS to the number of tests `pnpm test` passed, as TESTS=<n> node demo/render.mjs");
const facts = {
  date: new Date(meta.at).toISOString().slice(0, 10),
  repo: "Abulkosim/counterpart",
  tests: process.env.TESTS,
  attacks: total[1],
  held: total[2],
  model: model[1],
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
page.on("pageerror", (e) => { console.error("page error:", e.message); process.exit(1); });
await page.addInitScript(([t, h, f]) => Object.assign(window, { TAPE: t, HOSTILE: h, FACTS: f }), [tape, readFileSync(join(HERE, "hostile.txt"), "utf8"), facts]);
await page.goto(pathToFileURL(join(HERE, "video.html")).href);
await page.evaluate(() => window.ready);
const duration = await page.evaluate(() => window.DURATION);
console.log(`duration ${duration.toFixed(1)}s; scenes start at ${(await page.evaluate(() => window.SCENES)).map(([s]) => s.toFixed(1)).join(", ")}`);

const stills = process.argv.indexOf("--stills");
if (stills > 0) {
  for (const t of process.argv[stills + 1].split(",").map(Number)) {
    await page.evaluate((x) => window.seek(x), t);
    await page.screenshot({ path: join(OUT, `still-${String(t).padStart(5, "0")}.png`) });
  }
  await browser.close();
  process.exit(0);
}

const target = join(OUT, "counterpart-demo.mp4");
const enc = spawn(ffmpeg, ["-y", "-loglevel", "error", "-f", "image2pipe", "-framerate", String(FPS), "-c:v", "png", "-i", "-", "-c:v", "libx264", "-preset", "slow", "-crf", "17", "-pix_fmt", "yuv420p", "-movflags", "+faststart", target], { stdio: ["pipe", "inherit", "inherit"] });
const frames = Math.ceil(duration * FPS);
for (let i = 0; i < frames; i++) {
  await page.evaluate((x) => window.seek(x), i / FPS);
  const png = await page.screenshot({ type: "png" });
  if (!enc.stdin.write(png)) await new Promise((r) => enc.stdin.once("drain", r));
  if (i % 300 === 0) console.log(`frame ${i}/${frames}`);
}
enc.stdin.end();
await new Promise((r) => enc.on("close", r));
await browser.close();
console.log(`wrote ${target}`);
