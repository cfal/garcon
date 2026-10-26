import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseTestArguments, selectTestFiles } from '../run-test-files.js';

const root = resolve(import.meta.dir, '../..');
const workflow = Bun.YAML.parse(readFileSync(resolve(root, '.github/workflows/integration-tests.yml'), 'utf8'));
const lane = workflow.jobs['chromium-e2e-shard'];
const gate = workflow.jobs['chromium-e2e'];

test('Chromium matrix covers the entire inventory once with serial file isolation', () => {
  expect(lane.strategy['fail-fast']).toBe(false);
  const step = lane.steps.find(step => step.name === 'Run Chromium E2E');
  const shards = lane.strategy.matrix.shard;
  expect(step.env.CHROMIUM_SHARD).toBe('${{ matrix.shard }}/' + shards.length);
  expect(shards).toEqual(Array.from({ length: shards.length }, (_, index) => index + 1));
  expect(shards.length).toBeGreaterThan(1);
  expect(step.run).toBe('bun run test:integration:chromium --shard="$CHROMIUM_SHARD"');
  expect(lane['continue-on-error']).toBeUndefined();
  expect(step['continue-on-error']).toBeUndefined();

  const files = [...new Bun.Glob('integration-tests/tests/chromium/*.test.ts').scanSync({ cwd: root })];
  const selected = shards.flatMap(index => {
    const { shard } = parseTestArguments([`--shard=${index}/${shards.length}`]);
    return selectTestFiles(files, shard);
  });
  expect(selected.sort()).toEqual(files.sort());
  expect(new Set(selected).size).toBe(files.length);

  const scripts = JSON.parse(readFileSync(resolve(root, 'integration-tests/package.json'), 'utf8')).scripts;
  expect(scripts['test:chromium']).toBe("bun ../scripts/run-test-files.js 'tests/chromium/*.test.ts' --max-concurrency=1 --timeout=120000");
});

test('Chromium diagnostics remain separate for each failing shard', () => {
  const upload = lane.steps.find(step => step.name === 'Upload Chromium diagnostics');
  expect(upload.if).toBe('${{ failure() }}');
  expect(upload.with.name).toBe('chromium-e2e-diagnostics-${{ matrix.shard }}-of-2');
  expect(upload.with.path).toBe('integration-tests/artifacts/chromium/');
});

test('stable Chromium gate always runs and rejects every non-success result', () => {
  expect(gate.name).toBe('Chromium E2E');
  expect(gate.needs).toBe('chromium-e2e-shard');
  expect(gate.if).toBe('${{ always() }}');
  expect(gate['continue-on-error']).toBeUndefined();
  const step = gate.steps[0];
  expect(step.env.SHARDS_RESULT).toBe('${{ needs.chromium-e2e-shard.result }}');
  expect(step['continue-on-error']).toBeUndefined();
  for (const outcome of ['success', 'failure', 'cancelled', 'skipped', '']) {
    const result = Bun.spawnSync(['bash', '-e', '-c', step.run], {
      env: { ...process.env, SHARDS_RESULT: outcome },
      stdout: 'pipe', stderr: 'pipe',
    });
    expect(result.exitCode, outcome).toBe(outcome === 'success' ? 0 : 1);
  }
});
