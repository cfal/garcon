import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readClaudeReleaseChannel } from '../cli-updates.js';

let root: string;
beforeEach(async () => { root = await mkdtemp(path.join(os.tmpdir(), 'garcon-claude-channel-')); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

async function writeJson(filePath: string, value: unknown) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(value));
}

test('reads the release channel from user settings, with managed settings taking precedence', async () => {
  const config = { configHomeDir: () => path.join(root, 'claude') };
  const managed = path.join(root, 'managed', 'managed-settings.json');
  expect(await readClaudeReleaseChannel(config, managed)).toBe('latest');

  await writeJson(path.join(root, 'claude', 'settings.json'), { autoUpdatesChannel: 'stable' });
  expect(await readClaudeReleaseChannel(config, managed)).toBe('stable');

  await writeJson(managed, { autoUpdatesChannel: 'latest' });
  expect(await readClaudeReleaseChannel(config, managed)).toBe('latest');

  await writeJson(managed, { autoUpdatesChannel: 'nightly' });
  expect(await readClaudeReleaseChannel(config, managed)).toBe('stable');
});
