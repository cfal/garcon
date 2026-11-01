import { expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { addMissingFixtures } from './update-contract-wire-fixtures.js';

test('fixture establishment adds versions but refuses any changed existing promise', async () => {
  const scratch = join(homedir(), 'tmp');
  await mkdir(scratch, { recursive: true });
  const path = await mkdtemp(join(scratch, 'garcon-contract-fixtures-'));
  const directory = pathToFileURL(`${path}/`);
  try {
    await addMissingFixtures(directory, { 'operation@1': { request: 'one' } });
    await addMissingFixtures(directory, { 'operation@1': { request: 'one' }, 'operation@2': { request: 'two' } });
    await expect(addMissingFixtures(directory, { 'operation@1': { request: 'changed' }, 'operation@3': {} })).rejects.toThrow('operation@1');
    expect(await Bun.file(new URL('operation@1.json', directory)).json()).toEqual({ request: 'one' });
    expect(await Bun.file(new URL('operation@2.json', directory)).json()).toEqual({ request: 'two' });
    expect(await Bun.file(new URL('operation@3.json', directory)).exists()).toBe(false);
  } finally { await rm(path, { recursive: true, force: true }); }
});
