import { expect, test } from 'bun:test';
import { createRequire } from 'node:module';
import webConfig from '../../web/vite.config.ts';

const requireWeb = createRequire(new URL('../../web/package.json', import.meta.url));
const requireVite = createRequire(requireWeb.resolve('vite'));
const { rolldown } = await import(requireVite.resolve('rolldown'));

test('vendor groups have timing labels without replacing their chunk names', async () => {
  const modules = new Map([
    ['entry', `export const terminal = () => import('/fixture/node_modules/@xterm/xterm/index.js');
export const math = () => import('/fixture/node_modules/katex/index.js');`],
    ['/fixture/node_modules/@xterm/xterm/index.js', 'export const terminal = "terminal";'],
    ['/fixture/node_modules/katex/index.js', 'export const math = "math";'],
  ]);
  const warnings = [];
  const bundle = await rolldown({
    input: 'entry',
    checks: { bundlerTimings: true },
    onwarn: (warning) => warnings.push(warning),
    plugins: [{
      name: 'chunk-group-fixture',
      resolveId: (id) => modules.has(id) ? id : null,
      load: (id) => modules.get(id),
    }],
  });
  try {
    const { output } = await bundle.generate({
      format: 'es',
      codeSplitting: webConfig.build.rollupOptions.output.codeSplitting,
    });
    expect(warnings.filter(({ code }) => code === 'MISSING_CODE_SPLITTING_GROUP_DEBUG_NAME')).toEqual([]);
    const vendors = output.filter((file) => file.type === 'chunk' && file.name.startsWith('vendor-'));
    expect(vendors.map((file) => file.name).sort()).toEqual(['vendor-katex', 'vendor-xterm']);
  } finally {
    await bundle.close();
  }
});
