import { expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { originalFontCss, originalFontFamily } from '../../integration-tests/support/font-proof-sources.js';

const root = new URL('../../', import.meta.url);

test('font proofs keep the original five sources isolated from additional families', async () => {
  const sources = await Bun.file(new URL('scripts/fonts/sources.json', root)).json();
  const inventory = await Bun.file(new URL('scripts/fonts/inventory.json', root)).json();
  const expected = [
    ['DepartureMono-1.500.woff2', 'Departure Mono'],
    ['JetBrainsMono.woff2', 'JetBrains Mono'],
    ['JetBrainsMono-Italic.woff2', 'JetBrains Mono'],
    ['InterVariable.woff2', 'Inter'],
    ['InterVariable-Italic.woff2', 'Inter'],
  ];
  for (const entries of [sources, inventory.map(({ source }) => source)]) {
    const originalFamilies = entries
      .filter(({ file }) => originalFontFamily(file))
      .map(({ file }) => [file, originalFontFamily(file)]);
    expect(originalFamilies).toEqual(expected);
  }
  expect(originalFontFamily('toString')).toBeUndefined();
  expect(originalFontFamily('InterFuture.woff2')).toBeUndefined();
});

test.each([
  ['/source', ''],
  ['/__font_proof', ''],
  ['/source', 'Before '],
])('historical proof CSS preserves exact rules for %s with prefix "%s"', async (sourcePath, familyPrefix) => {
  const sources = await Bun.file(new URL('scripts/fonts/sources.json', root)).json();
  const expected = [
    "@font-face {font-family:'Departure Mono';src:url('/source/DepartureMono-1.500.woff2');font-style:normal;font-weight:400;font-display:swap;}",
    "@font-face {font-family:'JetBrains Mono';src:url('/source/JetBrainsMono.woff2');font-style:normal;font-weight:100 800;font-display:swap;}",
    "@font-face {font-family:'JetBrains Mono';src:url('/source/JetBrainsMono-Italic.woff2');font-style:italic;font-weight:100 800;font-display:swap;}",
    "@font-face {font-family:'Inter';src:url('/source/InterVariable.woff2');font-style:normal;font-weight:100 900;font-display:swap;}",
    "@font-face {font-family:'Inter';src:url('/source/InterVariable-Italic.woff2');font-style:italic;font-weight:100 900;font-display:swap;}",
  ].join('\n').replaceAll('/source/', `${sourcePath}/`).replaceAll("font-family:'", `font-family:'${familyPrefix}`);
  const inputs = [...sources, { file: 'toString' }, { file: 'InterFuture.woff2' }];
  expect(originalFontCss(inputs, sourcePath, familyPrefix)).toBe(expected);
  expect(originalFontCss([], sourcePath, familyPrefix)).toBe('');
});

test.each([
  'Arimo', 'AtkinsonHyperlegible', 'IBMPlexMono', 'Roboto',
  'SourceCodePro', 'SourceSans3', 'SourceSerif4',
])('%s includes its complete font license in runtime static assets', async (family) => {
  const source = await readFile(new URL(`scripts/fonts/sources/${family}-OFL.txt`, root), 'utf8');
  const distributed = await readFile(new URL(`web/static/licenses/${family}.txt`, root), 'utf8');
  expect(distributed.trimEnd()).toBe(source.replaceAll('\r\n', '\n').trimEnd());
  expect(distributed).toContain('SIL OPEN FONT LICENSE');
});
