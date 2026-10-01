import { expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { selectServerSuites, serverSuiteName, SINGLE_RUN_SUITES } from '../../support/server-suite-inventory.js';

const root = fileURLToPath(new URL('../..', import.meta.url));
const files = [...new Bun.Glob('tests/server/*.test.{ts,js}').scanSync({ cwd: root })];

test('server lanes share one inventory and new suites default to runtime parity', () => {
  const local = selectServerSuites(files, 'in-process');
  const remote = selectServerSuites(files, 'remote-controller-dials');
  expect(local).toEqual([...files].sort());
  expect(selectServerSuites(files, 'remote-executor-dials')).toEqual(remote);
  expect(selectServerSuites(['tests/server/new-runtime.test.ts'], 'remote-controller-dials'))
    .toEqual(['tests/server/new-runtime.test.ts']);
  const names = new Set(files.map(serverSuiteName));
  for (const [name, reason] of Object.entries(SINGLE_RUN_SUITES)) {
    expect(names.has(name)).toBe(true);
    expect(reason.length).toBeGreaterThan(20);
  }
  for (const name of ['chat-lifecycle', 'garcon-cli', 'git-comparison', 'git-refs', 'git-worktrees', 'git-read-deadline']) {
    expect(remote).toContain(`tests/server/${name}.test.ts`);
  }
});

test('matrix suites cannot silently pin their fixture to Local', async () => {
  for (const file of selectServerSuites(files, 'remote-controller-dials')) {
    const source = await readFile(`${root}/${file}`, 'utf8');
    expect(source, file).not.toMatch(/executionBackend:\s*['"]in-process['"]/);
  }
});

test('CI runs the shared server inventory and SACS on all three backends', async () => {
  const source = await readFile(`${root}/../.github/workflows/integration-tests.yml`, 'utf8');
  expect(Bun.YAML.parse(source)).toMatchObject({ jobs: {
    'server-integration-lane': { strategy: { matrix: {
      execution_backend: ['in-process', 'remote-controller-dials', 'remote-executor-dials'],
      suite: [
        ...[1, 2, 3, 4].map(shard => ({ script: 'test:server:lane', shard: `${shard}/4` })),
        { path: 'tests/sacs', shard: '1/1', test_timeout: 120000 },
      ],
    } } },
  } });
});

test('live CI lanes use agent-specific secrets and audit all private configuration', async () => {
  const source = await readFile(`${root}/../.github/workflows/integration-tests.yml`, 'utf8');
  const workflow = Bun.YAML.parse(source);
  for (const agent of ['claude', 'codex']) {
    const key = `${agent.toUpperCase()}_TESTING_KEY`;
    const baseUrl = `${agent.toUpperCase()}_TESTING_BASE_URL`;
    const model = `${agent.toUpperCase()}_TESTING_MODEL`;
    const environment = {
      [key]: '${{ secrets.' + key + ' }}',
      [baseUrl]: '${{ secrets.' + baseUrl + ' }}',
      [model]: '${{ secrets.' + model + ' }}',
    };
    expect(workflow).toMatchObject({ jobs: {
      [`${agent}-live`]: { steps: expect.arrayContaining([
        expect.objectContaining({ id: agent === 'claude' ? 'claude-config' : 'codex-key', env: environment }),
        expect.objectContaining({ run: `bun run test:live:${agent}`, env: environment }),
        expect.objectContaining({
          id: `${agent}-diagnostics-audit`, env: environment,
          run: expect.stringContaining(`for value in "$${key}" "$${baseUrl}" "$${model}"; do`),
        }),
      ]) },
    } });
  }
});
