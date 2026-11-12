import { expect, test } from 'bun:test';
import { assertEagerAssetBudget, assertLazyRendererAssets, collectEagerAssets } from '../../web/scripts/eager-assets.ts';
import { codeMirrorLanguageChunk } from '../../web/codemirror-chunks.ts';
import { CODEMIRROR_PACKAGES } from '../../web/codemirror-packages.ts';

test('classifies every installed language package as a lazy implementation', () => {
  for (const name of CODEMIRROR_PACKAGES.filter(name => name.startsWith('@codemirror/lang-'))) {
    const chunk = codeMirrorLanguageChunk(`/node_modules/${name}/dist/index.js`);
    expect(chunk).toMatch(/^vendor-cm-lang-/);
    expect(chunk).not.toBe('vendor-cm-lang-metadata');
  }
  expect(codeMirrorLanguageChunk('/node_modules/@codemirror/language-data/dist/index.js')).toBe('vendor-cm-lang-metadata');
  expect(codeMirrorLanguageChunk('/node_modules/@codemirror/language/dist/index.js')).toBeUndefined();
});

test('collects only static imports and their CSS, including cycles and shared output files', () => {
  const manifest = {
    entry: { file: 'entry.js', imports: ['metadata'], dynamicImports: ['markdown'], css: ['entry.css'] },
    metadata: { file: 'metadata.js', name: 'application-metadata', imports: ['entry'] },
    shared: { file: 'metadata.js', imports: ['runtime'], css: ['shared.css'] },
    runtime: { file: 'runtime.js', name: 'vite-runtime' },
    markdown: { file: 'markdown.js', name: 'vendor-cm-lang-template', imports: ['html'] },
    html: { file: 'html.js', name: 'vendor-cm-lang-markup', css: ['html.css'] },
  };
  const closure = collectEagerAssets(['entry.js', 'entry.js'], ['global.css'], manifest);
  expect([...closure.files]).toEqual(['entry.js', 'metadata.js', 'runtime.js']);
  expect([...closure.cssFiles]).toEqual(['global.css', 'entry.css', 'shared.css']);
  expect(closure.keysByFile.get('metadata.js')).toEqual(['metadata', 'shared']);
  const reports = (files) => [...files].map(file => ({
    file, names: Object.values(manifest).filter(entry => entry.file === file).flatMap(entry => entry.name ?? []),
  }));
  expect(() => assertLazyRendererAssets(reports(closure.files))).not.toThrow();
  manifest.metadata.imports.push('markdown');
  const regressed = collectEagerAssets(['entry.js'], [], manifest);
  expect(() => assertLazyRendererAssets(reports(regressed.files))).toThrow('Optional renderer chunks must remain lazy');
});

test('guards optional language metadata, editor runtimes, and feature engines', () => {
  for (const name of ['vendor-cm-lang-web', 'vendor-cm-lang-markup', 'vendor-cm-lang-template', 'vendor-cm-lang-programming', 'vendor-cm-legacy-modes', 'vendor-cm-lang-metadata', 'vendor-codemirror-core', 'vendor-codemirror', 'vendor-canvas', 'vendor-xterm']) {
    expect(() => assertLazyRendererAssets([{ file: 'chunk.js', names: [name] }])).toThrow();
  }
  expect(() => assertLazyRendererAssets([{ file: 'chunk.js', names: ['vite-runtime', 'vendor-svelte'] }])).not.toThrow();
});

test('guards raw eager bytes independently of chunk naming', () => {
  expect(() => assertEagerAssetBudget(3_400_000, 460_000)).not.toThrow();
  expect(() => assertEagerAssetBudget(3_400_001, 0)).toThrow('Eager asset budget exceeded');
  expect(() => assertEagerAssetBudget(0, 460_001)).toThrow('Eager asset budget exceeded');
});
