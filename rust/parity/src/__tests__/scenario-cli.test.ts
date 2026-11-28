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
