import { expect, test } from 'bun:test';
import { resolve } from 'node:path';

for (const mode of ['record', 'replay']) {
  test(`${mode} rejects an unknown scenario`, () => {
    const command = [process.execPath, resolve(import.meta.dir, '../../cli.ts'), mode, '--scenario', 'not-a-scenario'];
    if (mode === 'record') command.push('--any-bun');
    const result = Bun.spawnSync(command);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain('Unknown scenario: not-a-scenario');
  });
}

const probe = resolve(import.meta.dir, 'fixtures/probe-server.ts');
const cli = resolve(import.meta.dir, '../../cli.ts');
const settingsScenario = 'duplicate-http-headers';

function replayUnported(allow: boolean, mixed = false) {
  const build = [process.execPath, probe, '--settings-unported', ...(mixed ? ['--unmarked-settings-get'] : [])].join(' ');
  return Bun.spawnSync([process.execPath, cli, 'replay', '--build', build, '--label', 'native-probe',
    '--scenario', settingsScenario, ...(allow ? ['--allow-unported'] : [])]);
}

test('a live marked 501 is unported, not a match, and fails the strict replay', () => {
  const result = replayUnported(false);
  expect(result.exitCode).toBe(1);
  expect(result.stdout.toString()).toContain('Unported: 5/5 cases');
  expect(result.stdout.toString()).toContain('Mismatching: 0/5 cases');
  expect(result.stdout.toString()).toContain('UNPORTED duplicate-http-headers: 5 cases');
});

test('the replay option permits unported cases, not an unmarked 501', () => {
  const allowed = replayUnported(true);
  expect(allowed.exitCode).toBe(0);
  expect(allowed.stdout.toString()).toContain('Matched natively: 0/5 cases');
  expect(allowed.stdout.toString()).toContain('Unported: 5/5 cases');

  const mixed = replayUnported(true, true);
  expect(mixed.exitCode).toBe(1);
  expect(mixed.stdout.toString()).toContain('Unported: 4/5 cases');
  expect(mixed.stdout.toString()).toContain('Mismatching: 1/5 cases');
  expect(mixed.stdout.toString()).toContain('FAIL duplicate-http-headers/reads-the-write-with-joined-content-type at $.body.kind');
});
