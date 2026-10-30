import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';

const root = resolve(import.meta.dir, '../..');
const scripts = directory => JSON.parse(readFileSync(resolve(root, directory, 'package.json'), 'utf8')).scripts;
const rootScripts = scripts('.');
const integrationScripts = scripts('integration-tests');
const directoryLanes = ['sacs', 'e2e', 'live/claude', 'live/codex', 'live/opencode'];
const lanes = [
  { name: 'common', include: ['common/__tests__/*.test.js'] },
  { name: 'scripts', include: ['scripts/__tests__/*.test.js'] },
  { name: 'providers', include: ['server-agents/**/__tests__/*.{test.js,test.ts}'] },
  { name: 'server', include: ['server/**/__tests__/*.{test.js,test.ts}'] },
  { name: 'cli', include: ['cli/__tests__/*.test.ts'] },
  { name: 'web logic', include: ['web/src/**/*.logic.test.ts'] },
  { name: 'web ui', include: ['web/src/**/*.test.ts'], exclude: ['web/src/**/*.logic.test.ts'] },
  { name: 'integration server', include: ['integration-tests/tests/server/*.test.{ts,js}'] },
  ...directoryLanes.map(directory => ({
    name: directory, include: [`integration-tests/tests/${directory}/**/*.{test,spec}.{js,jsx,ts,tsx}`],
  })),
  { name: 'chromium', include: ['integration-tests/tests/chromium/*.test.ts'] },
  { name: 'webkit', include: ['integration-tests/tests/webkit/*.test.ts'] },
  { name: 'search scale', include: ['integration-tests/tests/search-gate/transcript-search-v9-scale-gate.test.ts'] },
  { name: 'search endurance', include: ['integration-tests/tests/search-gate/transcript-search-v9-endurance.test.ts'] },
];
const pattern = name => lanes.find(lane => lane.name === name).include[0];
const integrationPattern = name => pattern(name).replace(/^integration-tests\//, '');

function owners(file, definitions = lanes) {
  return definitions.filter(lane => lane.include.some(pattern => new Bun.Glob(pattern).match(file))
    && !lane.exclude?.some(pattern => new Bun.Glob(pattern).match(file))).map(lane => lane.name);
}

test('inventory patterns match the executable discovery commands', () => {
  expect(rootScripts.test).toBe('bun run test:server && bun run test:cli && bun run --cwd web test');
  expect(rootScripts['test:server']).toBe(`bun test ./${pattern('common')} && bun test ./${pattern('scripts')} && bun scripts/run-test-files.js '${pattern('providers')}' && bun scripts/run-test-files.js '${pattern('server')}'`);
  expect(rootScripts['test:cli']).toBe('bun run --cwd cli test');
  expect(scripts('cli').test).toBe(`bun test ${pattern('cli').replace(/^cli\//, '')}`);
  expect(scripts('web').test).toBe('vitest run');
  for (const [name, target] of [
    ['integration', 'test'], ['integration:server', 'test:server'], ['integration:e2e', 'test:e2e'],
    ['integration:chromium', 'test:chromium'], ['integration:webkit', 'test:webkit'], ['search-gate', 'test:search-gate'],
    ['search-endurance', 'test:search-endurance'], ['live', 'test:live'],
    ...['claude', 'codex', 'opencode'].map(agent => [`live:${agent}`, `test:live:${agent}`]),
  ]) {
    expect(rootScripts[`test:${name}`]).toBe(`bun run --cwd integration-tests ${target}`);
  }
  expect(integrationScripts).toMatchObject({
    test: 'bun run test:server',
    'test:server': 'bun run test:server:lane && bun run test:sacs',
    'test:server:lane': 'bun run run-server-tests.ts',
    'test:chromium': `bun ../scripts/run-test-files.js '${integrationPattern('chromium')}' --max-concurrency=1 --timeout=120000`,
    'test:webkit': `bun ../scripts/run-test-files.js '${integrationPattern('webkit')}' --max-concurrency=1 --timeout=120000`,
    'test:search-gate': `bun test --max-concurrency=1 --timeout=900000 ${integrationPattern('search scale')}`,
    'test:search-endurance': `bun test --max-concurrency=1 --timeout=2400000 ${integrationPattern('search endurance')}`,
    'test:live': 'bun run test:live:claude && bun run test:live:codex && bun run test:live:opencode',
  });
  const timeouts = [120000, 60000, 120000, 240000, 180000];
  directoryLanes.forEach((directory, index) => {
    expect(integrationScripts[`test:${directory.replace('/', ':')}`])
      .toBe(`bun test --max-concurrency=1 --timeout=${timeouts[index]} tests/${directory}`);
  });
  const runner = readFileSync(resolve(root, 'integration-tests/run-server-tests.ts'), 'utf8');
  expect(runner).toContain(`new Bun.Glob('${integrationPattern('integration server')}')`);

  const config = ts.createSourceFile('vitest.config.ts', readFileSync(resolve(root, 'web/vitest.config.ts'), 'utf8'), ts.ScriptTarget.Latest, true);
  const patterns = [];
  function visit(node) {
    if (ts.isPropertyAssignment(node) && ['include', 'exclude'].includes(node.name.getText(config))
      && ts.isArrayLiteralExpression(node.initializer)) {
      const values = node.initializer.elements.filter(ts.isStringLiteral).map(value => value.text);
      if (values.some(value => value.startsWith('src/'))) patterns.push([node.name.getText(config), values]);
    }
    ts.forEachChild(node, visit);
  }
  visit(config);
  expect(patterns).toEqual([
    ['include', [pattern('web logic').replace(/^web\//, '')]],
    ['exclude', lanes.find(lane => lane.name === 'web ui').exclude.map(value => value.replace(/^web\//, ''))],
    ['include', [pattern('web ui').replace(/^web\//, '')]],
  ]);
});

test('every repository test file belongs to exactly one primary lane', () => {
  // Backend matrices, shards and capability reruns subdivide or repeat these primary lanes.
  const result = Bun.spawnSync(['git', 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: root });
  expect(result.exitCode).toBe(0);
  const files = [...new Set(result.stdout.toString().split('\0'))]
    .filter(file => /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file));
  expect(files.length).toBeGreaterThan(1800);
  expect(files.flatMap(file => owners(file).length === 1 ? [] : [`${file}: ${owners(file).join(', ') || 'UNDISCOVERED'}`]))
    .toEqual([]);
});

test('inventory matching catches unsupported extensions, nesting and overlapping lanes', () => {
  for (const file of ['common/__tests__/new.test.ts', 'scripts/__tests__/new.test.ts',
    'cli/__tests__/nested/new.test.ts', 'web/src/new.test.js', 'integration-tests/tests/unknown/new.test.ts']) {
    expect(owners(file), file).toEqual([]);
  }
  expect(owners('web/src/new.logic.test.ts')).toEqual(['web logic']);
  expect(owners('web/src/new.test.ts')).toEqual(['web ui']);
  expect(owners('common/__tests__/new.test.js', [...lanes, lanes[0]])).toEqual(['common', 'common']);
});
