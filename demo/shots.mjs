// Screenshots of the local viewer for the demo video.
//   node demo/shots.mjs <viewer url with token> <out dir> <thread id> <proposal id>
import { chromium } from "playwright";

const [url, out, thread, proposal] = process.argv.slice(2);
const base = url.split("#")[0];
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, colorScheme: "light" });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
await page.goto(url);
await page.waitForTimeout(1200);
const shot = async (hash, name, fullPage = false) => {
  await page.goto(`${base}#/${hash}`);
  await page.waitForTimeout(900);
  await page.screenshot({ path: `${out}/${name}.png`, fullPage });
};
await shot("threads", "view-threads");
await shot(`t/${encodeURIComponent(thread)}/c/${encodeURIComponent(proposal)}`, "view-proposal", true);
await shot("desk", "view-desk", true);
const links = await page.$$eval("a", (as) => as.map((a) => a.getAttribute("href")));
console.log("viewer shots done;", errors.length, "page errors;", links.length, "links on the desk page");
await browser.close();
if (errors.length) process.exit(1);
