/** Compares original and generated fonts across the application's typography range. */
import { chromium } from 'playwright';
import { mkdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../..');
const output = resolve(process.argv[2] ?? '/projects/font-optimization-evidence/matrix');
await mkdir(output, { recursive: true });
const sources: { file: string }[] = await Bun.file(join(root, 'scripts/fonts/sources.json')).json();
const before = sources.map(({ file }) => {
  const family = file.startsWith('Inter') ? 'Inter' : file.startsWith('JetBrains') ? 'JetBrains Mono' : 'Departure Mono';
  return `@font-face {font-family:'${family}';src:url('/source/${file}');font-style:${file.includes('Italic') ? 'italic' : 'normal'};font-weight:${family === 'Inter' ? '100 900' : family === 'JetBrains Mono' ? '100 800' : '400'};font-display:swap;}`;
}).join('\n');
const after = (await readFile(join(root, 'web/src/lib/theme/font-faces.css'), 'utf8')).replaceAll('./assets/', '/output/');
const weights = [400, 500, 550, 600, 620, 700, 800, 900];
const sizes = [9, 10, 10.5, 11, 12, 13, 14, 15, 16, 17.5, 18, 20, 24, 32, 36];
const server = Bun.serve({
  port: 0,
  fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/style.css') return new Response(url.searchParams.has('before') ? before : after, { headers: { 'Content-Type': 'text/css' } });
    if (url.pathname.startsWith('/source/')) return new Response(Bun.file(join(root, 'scripts/fonts/sources', url.pathname.split('/').pop()!)));
    if (url.pathname.startsWith('/output/')) return new Response(Bun.file(join(root, 'web/src/lib/theme/assets', url.pathname.split('/').pop()!)));
    const family = url.searchParams.get('family');
    return new Response(`<meta charset="utf-8"><link rel="stylesheet" href="/style.css${url.search}"><style>body{margin:0;background:white;color:black}.row{white-space:pre;line-height:1.5}</style><section style="font-family:'${family}',sans-serif">` + ['normal', 'italic'].flatMap(style => sizes.flatMap(size => weights.map(weight => `<div class="row" style="font-size:${size}px;font-weight:${weight};font-style:${style}">AVATAR To fi fl ffi -> != === “quotes”—… café ÁV ÁV ĀŽ œ ß Œ q\u0301\u0327 A\u030b\u0301 x\u0338 Ĳ\u0301 ĳ\u0301 Ƃ\u0301 Ƅ\u0301 ı\u0301 ø\u0301 ð\u0301 ƂA ƄA ıA øA ðA ∑ α Ж 中文 日本語 한국어 <span style="font-variant-numeric:tabular-nums">0123456789</span> hyphen‐ − ≤ A   A Ƃ   Ƃ</div>`))).join('') + '</section>', { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  },
});
const browser = await chromium.launch({ headless: true });
try {
  for (const family of ['Departure Mono', 'JetBrains Mono', 'Inter']) {
    for (const mode of ['before', 'after']) {
      const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
      await page.goto(`http://localhost:${server.port}/?${mode}&family=${encodeURIComponent(family)}`);
      await page.evaluate(async () => { document.body.getBoundingClientRect(); await document.fonts.ready; await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))); });
      await page.screenshot({ path: join(output, `${family.replaceAll(' ', '-')}-${mode}.png`), fullPage: true });
      await page.close();
    }
  }
} finally {
  await browser.close();
  server.stop();
}
console.log(`Captured ${3 * 2 * sizes.length * weights.length} samples per revision in ${output}.`);
