import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { ANTIGRAVITY_BINARY } from '../../support/scripted-antigravity.js';
import {
  allSacsScriptedDriverFactories,
  sacsScriptedDriverFactories,
} from './drivers.js';

test('[TLV5-L12.04-SACS-REGISTRY-01] registers every required scripted integration exactly once', () => {
  const ids = allSacsScriptedDriverFactories.map((driver) => driver.id);
  expect(ids).toEqual([
    'claude',
    'codex',
    'direct-openai-responses-compatible',
    'direct-openai-compatible',
    'direct-anthropic-compatible',
    ...(process.platform === 'linux' ? ['opencode'] : []),
    'pi',
    ...(ANTIGRAVITY_BINARY ? ['antigravity'] : []),
  ]);
  expect(new Set(ids).size).toBe(ids.length);
  if (process.env.GARCON_SACS_DRIVERS === undefined) {
    expect(sacsScriptedDriverFactories).toBe(allSacsScriptedDriverFactories);
  }
});

test('only registers the requested drivers and rejects unknown or empty selections', () => {
  const script = 'import { sacsScriptedDriverFactories as drivers } from "./tests/sacs/drivers.ts"; console.log(JSON.stringify(drivers.map(({id}) => id)));';
  const run = (selection: string) => Bun.spawnSync([process.execPath, '-e', script], {
    cwd: join(import.meta.dir, '../..'),
    env: { ...process.env, GARCON_SACS_DRIVERS: selection },
  });
  const selected = run('codex, claude');
  expect(selected.exitCode).toBe(0);
  expect(JSON.parse(selected.stdout.toString())).toEqual(['claude', 'codex']);
  for (const selection of ['claude,unknown', '']) {
    const invalid = run(selection);
    expect(invalid.exitCode).not.toBe(0);
    expect(invalid.stderr.toString()).toContain('GARCON_SACS_DRIVERS');
  }
});
