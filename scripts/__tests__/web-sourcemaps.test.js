import { expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import webConfig from '../../web/vite.config.ts';

const require = createRequire(new URL('../../web/package.json', import.meta.url));
const { createBuilder, createLogger } = await import(require.resolve('vite'));

test.each(['ssr', 'client', 'serviceWorker'])('%s CSS URLs preserve the sourcemap policy', async (name) => {
  const root = await mkdtemp(join(tmpdir(), 'garcon-sourcemaps-'));
  try {
    await writeFile(join(root, 'entry.js'), `import url from './terminal.css?url';\nexport function stylesheet() { return url; }\n`);
    await writeFile(join(root, 'terminal.css'), '.terminal { color: green; }');
    const warnings = [];
    const logger = createLogger('silent');
    logger.warn = (message) => warnings.push(message);
    const builder = await createBuilder({
      configFile: false,
      root,
      customLogger: logger,
      builder: { sharedConfigBuild: true },
      build: {
        sourcemap: webConfig.build.sourcemap,
        write: false,
        minify: false,
        rolldownOptions: { input: join(root, 'entry.js'), preserveEntrySignatures: 'strict' },
      },
      environments: {
        [name]: {
          consumer: name === 'ssr' ? 'server' : 'client',
          build: {
            emitAssets: true,
            // Mirrors Kit's server default; browser environments inherit the app policy.
            ...(name === 'ssr' ? { sourcemap: webConfig.build.sourcemap ?? true } : {}),
            ...webConfig.environments?.[name]?.build,
          },
        },
      },
    });
    const { output } = await builder.build(builder.environments[name]);
    expect(warnings.filter((message) => message.includes('SOURCEMAP_BROKEN'))).toEqual([]);
    const entry = output.find((file) => file.type === 'chunk' && file.isEntry);
    expect(entry.code).not.toContain('__VITE_CSS_URL__');
    expect(output.some((file) => file.type === 'asset' && file.fileName.endsWith('.css'))).toBe(true);
    expect(Boolean(entry.map?.mappings)).toBe(name === 'ssr');
    expect(output.some((file) => file.fileName.endsWith('.map'))).toBe(name === 'ssr');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
