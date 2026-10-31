/** Compares browser advances and ink bounds for every advertised source character. */
import { chromium } from 'playwright';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../..');
const output = resolve(process.argv[2] ?? '/projects/font-optimization-evidence/glyphs');
const quick = process.argv.includes('--quick');
await mkdir(output, { recursive: true });
const inventory: { source: { file: string; unicodeRange: string; sha256: string } }[] = await Bun.file(join(root, 'scripts/fonts/inventory.json')).json();
const familyFor = (file: string) => file.startsWith('Inter') ? 'Inter' : file.startsWith('JetBrains') ? 'JetBrains Mono' : 'Departure Mono';
const before = inventory.map(({ source: { file } }) => {
  const family = familyFor(file);
  return `@font-face {font-family:'Before ${family}';src:url('/source/${file}');font-style:${file.includes('Italic') ? 'italic' : 'normal'};font-weight:${family === 'Inter' ? '100 900' : family === 'JetBrains Mono' ? '100 800' : '400'};font-display:swap;}`;
}).join('\n');
const after = (await readFile(join(root, 'web/src/lib/theme/font-faces.css'), 'utf8'))
  .replaceAll('./assets/', '/output/')
  .replace(/font-family: '([^']+)'/g, "font-family: 'After $1'");
const server = Bun.serve({
  port: 0,
  fetch(request) {
    const path = new URL(request.url).pathname;
    if (path.startsWith('/source/')) return new Response(Bun.file(join(root, 'scripts/fonts/sources', path.split('/').pop()!)));
    if (path.startsWith('/output/')) return new Response(Bun.file(join(root, 'web/src/lib/theme/assets', path.split('/').pop()!)));
    return new Response(`<meta charset="utf-8"><style>${before}\n${after}\nbody{margin:0;background:white;color:black}</style>`, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  },
});
const browser = await chromium.launch({ headless: true });
const results = [];
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1 });
  await page.goto(`http://localhost:${server.port}`);
  for (const family of ['Departure Mono', 'JetBrains Mono', 'Inter']) {
    const faces = inventory.filter(({ source }) => familyFor(source.file) === family);
    const points = [...new Set(faces.flatMap(({ source }) => source.unicodeRange.split(', ').flatMap(range => {
      const [start, end = start] = range.slice(2).split('-').map(value => parseInt(value, 16));
      return Array.from({ length: end - start + 1 }, (_, index) => start + index);
    })))].sort((a, b) => a - b);
    const result = await page.evaluate(async ({ family, points, quick }) => {
      const text = String.fromCodePoint(...points);
      for (const mode of ['Before', 'After']) {
        for (const style of ['normal', 'italic']) await document.fonts.load(`${style} 400 14px "${mode} ${family}"`, text);
      }
      await document.fonts.ready;
      const containers = ['Before', 'After'].map(mode => {
        const container = document.createElement('div');
        container.style.cssText = `position:absolute;visibility:hidden;display:flex;flex-wrap:wrap;font-family:"${mode} ${family}"`;
        const spans = points.map(point => {
          const span = document.createElement('span');
          span.style.cssText = 'display:inline-block;white-space:pre;flex:none';
          span.textContent = String.fromCodePoint(point);
          container.append(span);
          return span;
        });
        document.body.append(container);
        return { container, spans };
      });
      const canvas = document.createElement('canvas').getContext('2d')!;
      const failures: unknown[] = [];
      let comparisons = 0;
      let changed = 0;
      const sizes = quick ? [12, 14] : [9, 10, 10.5, 11, 12, 13, 14, 15, 16, 17.5, 18, 20, 24, 32, 36];
      const weights = quick ? [400] : [400, 500, 550, 600, 620, 700, 800, 900];
      for (const style of ['normal', 'italic']) for (const size of sizes) for (const weight of weights) for (const features of ['normal', '"tnum" 1']) {
        for (const { container } of containers) Object.assign(container.style, { fontStyle: style, fontSize: `${size}px`, fontWeight: String(weight), fontFeatureSettings: features });
        const widths = containers.map(({ spans }) => spans.map(span => span.getBoundingClientRect().width));
        const ink = features === 'normal' ? ['Before', 'After'].map(mode => {
          canvas.font = `${style} ${weight} ${size}px "${mode} ${family}"`;
          return points.map(point => {
            const metrics = canvas.measureText(String.fromCodePoint(point));
            return [metrics.width, metrics.actualBoundingBoxLeft, metrics.actualBoundingBoxRight, metrics.actualBoundingBoxAscent, metrics.actualBoundingBoxDescent];
          });
        }) : null;
        for (let index = 0; index < points.length; index++) {
          comparisons++;
          if (widths[0][index] !== widths[1][index] || (ink && JSON.stringify(ink[0][index]) !== JSON.stringify(ink[1][index]))) {
            changed++;
            if (failures.length < 40) failures.push({ point: `U+${points[index].toString(16).toUpperCase()}`, style, size, weight, features, beforeWidth: widths[0][index], afterWidth: widths[1][index], beforeInk: ink?.[0][index], afterInk: ink?.[1][index] });
          }
        }
      }
      for (const { container } of containers) container.remove();
      const spaces = points.filter(point => /[\p{Z}\p{Cf}]/u.test(String.fromCodePoint(point)));
      const contexts = spaces.flatMap(point => ['A', 'Ƃ', '∑'].flatMap(base => [base + String.fromCodePoint(point), String.fromCodePoint(point) + base]));
      const mixed = [];
      let mixedComparisons = 0;
      for (const style of ['normal', 'italic']) for (const size of sizes) for (const weight of weights) for (const value of contexts) {
        const widths = ['Before', 'After'].map(mode => {
          canvas.font = `${style} ${weight} ${size}px "${mode} ${family}"`;
          return canvas.measureText(value).width;
        });
        mixedComparisons++;
        if (widths[0] !== widths[1]) mixed.push({ style, size, weight, text: value, before: widths[0], after: widths[1] });
      }
      return { family, characters: points.length, sizes, weights, styles: ['normal', 'italic'], features: ['normal', 'tnum'], comparisons, changed, failures, mixedComparisons, mixed };
    }, { family, points, quick });
    results.push(result);
    console.log(family, result.comparisons, 'character/configuration comparisons;', result.changed, 'changed;', result.mixed.length, 'mixed-run failures');
    for (const style of ['normal', 'italic']) for (const features of ['normal', 'tnum']) for (const mode of ['Before', 'After']) {
      await page.evaluate(async ({ family, points, style, features, mode }) => {
        const grid = document.createElement('section');
        grid.style.cssText = `display:grid;grid-template-columns:repeat(32,40px);font: ${style} 400 14px "${mode} ${family}";font-feature-settings:${features === 'tnum' ? '"tnum" 1' : 'normal'};line-height:24px`;
        for (const point of points) {
          const span = document.createElement('span');
          span.style.cssText = 'white-space:pre;height:24px';
          span.textContent = String.fromCodePoint(point);
          grid.append(span);
        }
        document.body.replaceChildren(grid);
        document.body.getBoundingClientRect();
        await document.fonts.ready;
        await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      }, { family, points, style, features, mode });
      await page.screenshot({ path: join(output, `${family.replaceAll(' ', '-')}-${style}-${features}-${mode.toLowerCase()}.png`), fullPage: true });
    }
    await writeFile(join(output, 'glyph-metrics.json'), JSON.stringify(results, null, 2) + '\n');
  }
} finally {
  await browser.close();
  server.stop();
}
if (results.some(result => result.changed || result.mixed.length)) process.exitCode = 1;
