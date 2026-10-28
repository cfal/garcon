import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
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

test('WebKit smoke runs independently with bounded setup, tests and diagnostics', () => {
  const webkit = workflow.jobs['webkit-e2e'];
  expect(webkit.name).toBe('WebKit E2E');
  expect(webkit['runs-on']).toBe('ubuntu-latest');
  expect(webkit['continue-on-error']).toBeUndefined();
  expect(webkit.if).toBeUndefined();
  const install = webkit.steps.find(step => step.name === 'Install WebKit');
  expect(install.run).toBe('bunx playwright install --with-deps webkit');
  expect(install.if).toBeUndefined();
  expect(install['timeout-minutes']).toBe(10);
  const run = webkit.steps.find(step => step.name === 'Run WebKit E2E');
  expect(run.run).toBe('bun run test:integration:webkit');
  expect(run['timeout-minutes']).toBe(5);
  expect(run['continue-on-error']).toBeUndefined();
  expect(run.if).toBeUndefined();
  const upload = webkit.steps.find(step => step.name === 'Upload WebKit diagnostics');
  expect(upload.if).toBe('${{ failure() || cancelled() }}');
  expect(upload['timeout-minutes']).toBe(2);
  expect(upload.with.name).toBe('webkit-e2e-diagnostics');
  expect(upload.with.path).toContain('integration-tests/artifacts/webkit/');
});

test('live lanes fail closed without configuration except on credential-free PRs', () => {
  const directory = mkdtempSync(join(tmpdir(), 'garcon-live-ci-contract-'));
  try {
    for (const agent of ['claude', 'codex', 'opencode']) {
      const check = workflow.jobs[`${agent}-live`].steps[0];
      expect(check.env).toMatchObject({
        EVENT_NAME: '${{ github.event_name }}',
        HEAD_REPO: '${{ github.event.pull_request.head.repo.full_name }}',
        REPO: '${{ github.repository }}', ACTOR: '${{ github.actor }}',
      });
      const keys = Object.keys(check.env).filter(key => key.includes('TESTING'));
      const configurations = [[], ...keys.map(key => keys.filter(other => other !== key)), keys];
      for (const configured of configurations) {
        for (const [event, head, actor, credentialFree] of [
          ['push', '', 'owner', false],
          ['workflow_dispatch', '', 'owner', false],
          ['pull_request', 'owner/repo', 'owner', false],
          ['pull_request', '', 'owner', false],
          ['pull_request', 'fork/repo', 'contributor', true],
          ['pull_request', 'owner/repo', 'dependabot[bot]', true],
          ['push', '', 'dependabot[bot]', false],
        ]) {
          const output = join(directory, 'output');
          writeFileSync(output, '');
          const result = Bun.spawnSync(['bash', '-eu', '-c', check.run], {
            env: {
              PATH: process.env.PATH, GITHUB_OUTPUT: output,
              EVENT_NAME: event, HEAD_REPO: head, REPO: 'owner/repo', ACTOR: actor,
              ...Object.fromEntries(keys.map(key => [key, configured.includes(key) ? 'synthetic-test-value' : ''])),
            }, stdout: 'pipe', stderr: 'pipe',
          });
          const complete = configured.length === keys.length;
          expect(result.exitCode, `${agent}: ${event}/${head}/${actor}, ${configured}`)
            .toBe(complete || credentialFree ? 0 : 1);
          expect(readFileSync(output, 'utf8')).toBe(complete ? 'available=true\n' : '');
        }
      }
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
