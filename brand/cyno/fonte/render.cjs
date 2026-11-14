/* eslint-disable @typescript-eslint/no-require-imports -- script de linha de comando em CommonJS */
/* global document */
// Render SVGs to PNGs or screenshot an HTML file with Playwright's Chromium (one browser for all files).
// usage:
//   node render.cjs png <outDir> <size> [--bg #hex] file.svg ...
//   node render.cjs sheet <out.png> <width> file.svg ...        (contact sheet: light + dark + 32/16 px)
//   node render.cjs html <page.html> <out.png> <width>
const { chromium } = require("playwright-core");
const fs = require("fs");
const path = require("path");

(async () => {
  const [mode, ...args] = process.argv.slice(2);
  const browser = await chromium.launch({ channel: "chromium" });
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  if (mode === "png") {
    let [outDir, size, ...files] = args;
    let bg = "transparent";
    const bi = files.indexOf("--bg");
    if (bi >= 0) { bg = files[bi + 1]; files.splice(bi, 2); }
    fs.mkdirSync(outDir, { recursive: true });
    for (const f of files) {
      const svg = fs.readFileSync(f, "utf8");
      const vb = svg.match(/viewBox="([^"]+)"/)[1].split(/\s+/).map(Number);
      const s = Number(size);
      const w = Math.round((vb[2] / vb[3]) * s);
      await page.setViewportSize({ width: w, height: s });
      await page.setContent(`<html><body style="margin:0;background:${bg}"><img src="data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}" style="display:block;width:${w}px;height:${s}px"></body></html>`);
      const out = path.join(outDir, path.basename(f).replace(/\.svg$/, `-${s}.png`));
      await page.screenshot({ path: out, omitBackground: bg === "transparent" });
      console.log("wrote", out);
    }
  } else if (mode === "sheet") {
    const [out, width, ...files] = args;
    const cell = (f) => {
      const b64 = Buffer.from(fs.readFileSync(f, "utf8")).toString("base64");
      const src = `data:image/svg+xml;base64,${b64}`;
      const wide = /lockup|wordmark/.test(f);
      const big = wide ? `height:120px` : `height:200px`;
      return `<div class="row"><div class="lbl">${path.basename(f)}</div>
        <div class="bx light"><img src="${src}" style="${big}"><img src="${src}" style="height:32px"><img src="${src}" style="height:16px"></div>
        <div class="bx dark"><img src="${src}" style="${big}"><img src="${src}" style="height:32px"><img src="${src}" style="height:16px"></div></div>`;
    };
    const html = `<html><head><style>body{margin:0;font:12px sans-serif;background:#e9e9ee}
      .row{display:flex;gap:8px;padding:8px;align-items:stretch}.lbl{width:150px}
      .bx{flex:1;display:flex;gap:20px;align-items:flex-end;padding:16px;border-radius:8px}
      .light{background:#fff}.dark{background:#0B0D1A}</style></head><body>${files.map(cell).join("")}</body></html>`;
    await page.setViewportSize({ width: Number(width), height: 400 });
    await page.setContent(html);
    await page.waitForTimeout(200);
    await page.screenshot({ path: out, fullPage: true });
    console.log("wrote", out);
  } else if (mode === "parts") {
    const [html, outPrefix, width, partH] = args;
    await page.setViewportSize({ width: Number(width), height: 900 });
    await page.goto("file://" + path.resolve(html));
    await page.waitForTimeout(800);
    const total = await page.evaluate(() => document.documentElement.scrollHeight);
    for (let y = 0, k = 0; y < total; y += Number(partH), k++) {
      const h = Math.min(Number(partH), total - y);
      await page.screenshot({ path: `${outPrefix}-${k}.png`, fullPage: true, clip: { x: 0, y, width: Number(width), height: h } });
      console.log("wrote", `${outPrefix}-${k}.png`);
    }
  } else if (mode === "html") {
    const [html, out, width] = args;
    await page.setViewportSize({ width: Number(width), height: 900 });
    await page.goto("file://" + path.resolve(html));
    await page.waitForTimeout(800);
    await page.screenshot({ path: out, fullPage: true });
    console.log("wrote", out);
  }
  await browser.close();
})();
