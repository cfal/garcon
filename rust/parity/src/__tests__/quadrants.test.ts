import { expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const cli = join(import.meta.dir, '../../quadrants.ts');
const cases = (...entries: string[]) => `<testsuites><testsuite>${entries.join('')}</testsuite></testsuites>`;
const entry = (name: string, detail = '') => `<testcase file="tests/example.test.ts" name="${name}">${detail}</testcase>`;

test('reports optional quadrants, distinguishes shared failures, and lists sorted differences', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'parity-junit-'));
  try {
    const original = join(directory, 'original.xml');
    const changed = join(directory, 'changed.xml');
    await writeFile(original, cases(entry('zeta'), entry('alpha'), entry('shared failure', '<failure/>')));
    await writeFile(changed, cases(entry('zeta', '<skipped/>'), entry('beta'), entry('shared failure', '<error/>')));
    const run = (...args: string[]) => Bun.spawnSync([process.execPath, cli, '--original', original, ...args]);
    const diff = run('--rust-local', changed, '--rust-worker', original);
    expect(diff.exitCode).toBe(1);
    expect(diff.stdout.toString()).toBe([
      '| Quadrant | Same outcome | Different outcome | Failed in both |',
      '| --- | ---: | ---: | ---: |',
      '| rust-worker | 3 | 0 | 1 |',
      '| rust-local | 1 | 3 | 1 |',
      'DIFFERS rust-local: tests/example.test.ts > alpha: original=pass quadrant=absent',
      'DIFFERS rust-local: tests/example.test.ts > beta: original=absent quadrant=pass',
      'DIFFERS rust-local: tests/example.test.ts > zeta: original=pass quadrant=skip',
      '',
    ].join('\n'));
    expect(run('--rust-controller', original, '--rust-both', original).exitCode).toBe(0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
