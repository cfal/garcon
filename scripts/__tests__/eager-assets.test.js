import { expect, test } from 'bun:test';
import { assertLazyLanguageAssets, collectEagerAssets } from '../../web/scripts/eager-assets.ts';

test('collects only static imports and their CSS, including cycles and shared output files', () => {
  const manifest = {
    entry: { file: 'entry.js', imports: ['metadata'], dynamicImports: ['markdown'], css: ['entry.css'] },
    metadata: { file: 'metadata.js', name: 'vendor-cm-lang-metadata', imports: ['entry'] },
    shared: { file: 'metadata.js', imports: ['runtime'], css: ['shared.css'] },
    runtime: { file: 'runtime.js', name: 'vendor-codemirror' },
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
  expect(() => assertLazyLanguageAssets(reports(closure.files))).not.toThrow();
  manifest.metadata.imports.push('markdown');
  const regressed = collectEagerAssets(['entry.js'], [], manifest);
  expect(() => assertLazyLanguageAssets(reports(regressed.files))).toThrow('Language implementation chunks must remain lazy');
});

test('guards every implementation chunk family but permits metadata and editor runtime', () => {
  for (const name of ['vendor-cm-lang-web', 'vendor-cm-lang-markup', 'vendor-cm-lang-template', 'vendor-cm-lang-programming', 'vendor-cm-legacy-modes']) {
    expect(() => assertLazyLanguageAssets([{ file: 'chunk.js', names: [name] }])).toThrow();
  }
  expect(() => assertLazyLanguageAssets([{ file: 'chunk.js', names: ['vendor-cm-lang-metadata', 'vendor-codemirror'] }])).not.toThrow();
});
