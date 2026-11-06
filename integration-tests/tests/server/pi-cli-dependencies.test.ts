import { afterAll, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Pi's published bundle inlines its dependencies, so a lockfile override never reaches it.
// These floors assert what the spawned process loads, which is what actually runs.
const PATCHED_MODULES: Readonly<Record<string, string>> = { undici: '>=8.12.2', minimatch: '>=11.0.1' };
const PI_BINARIES = {
  integration: fileURLToPath(new URL('../../node_modules/.bin/pi', import.meta.url)),
  production: fileURLToPath(new URL('../../../server-agents/pi/node_modules/.bin/pi', import.meta.url)),
};

const workspace = mkdtempSync(join(tmpdir(), 'garcon-pi-cli-dependencies-'));
afterAll(() => rmSync(workspace, { recursive: true, force: true }));

const LOAD_RECORDER = `
import { appendFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
registerHooks({
  load(url, context, nextLoad) {
    appendFileSync(process.env.GARCON_TEST_LOADED_MODULES, url + '\\n');
    return nextLoad(url, context);
  },
});
`;

function packageRootOf(moduleUrl: string, name: string): string | null {
  const marker = `/node_modules/${name}/`;
  const index = moduleUrl.indexOf(marker);
  return index === -1 ? null : fileURLToPath(moduleUrl.slice(0, index + marker.length));
}

test.each(Object.entries(PI_BINARIES))('the %s Pi CLI loads patched dependencies from node_modules', async (label, binary) => {
  const recorder = join(workspace, `${label}-recorder.mjs`);
  const loadedModules = join(workspace, `${label}-loaded.txt`);
  writeFileSync(recorder, LOAD_RECORDER);
  writeFileSync(loadedModules, '');
  const nodeBinary = Bun.which('node');
  if (!nodeBinary) throw new Error('node is required to run the pinned Pi CLI');

  const pi = Bun.spawn([binary, '--version'], {
    cwd: workspace,
    env: {
      PATH: dirname(nodeBinary),
      HOME: workspace,
      PI_CODING_AGENT_DIR: join(workspace, 'agent'),
      PI_SKIP_VERSION_CHECK: '1',
      NODE_OPTIONS: `--import=${recorder}`,
      GARCON_TEST_LOADED_MODULES: loadedModules,
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stderr, exitCode] = await Promise.all([new Response(pi.stderr).text(), pi.exited]);
  expect(exitCode, stderr).toBe(0);

  const loaded = readFileSync(loadedModules, 'utf8').split('\n').filter(Boolean);
  expect(loaded.filter((url) => url.includes('/pi-coding-agent/dist/bundle/chunks/'))).toEqual([]);
  for (const [name, floor] of Object.entries(PATCHED_MODULES)) {
    const roots = new Set(loaded.flatMap((url) => packageRootOf(url, name) ?? []));
    expect(roots.size, `${name} was not loaded by ${realpathSync(binary)}`).toBeGreaterThan(0);
    for (const root of roots) {
      const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version: string };
      expect(Bun.semver.satisfies(version, floor), `${name}@${version} does not satisfy ${floor}`).toBe(true);
    }
  }
});
