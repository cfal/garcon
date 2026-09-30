import { afterEach, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { FileAgentMigrationStore } from '../integration-migration-store.js';

const createdDirectories: string[] = [];

afterEach(async () => {
  for (const directory of createdDirectories.splice(0)) await rm(directory, { recursive: true, force: true });
});

test('names migration state that is not JSON without echoing it', async () => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), 'garcon-agent-migration-'));
  createdDirectories.push(workspaceDir);
  const statePath = path.join(workspaceDir, 'agent-data', 'alpha', 'migration-state.json');
  await mkdir(path.dirname(statePath), { recursive: true });
  await writeFile(statePath, '{"version": SYNTHETIC_SENTINEL');

  const failure = await new FileAgentMigrationStore(workspaceDir, 'alpha').getVersion().catch((error: unknown) => error);

  expect(failure).not.toBeInstanceOf(SyntaxError);
  expect((failure as Error).message).toBe(`Invalid agent migration state: ${statePath}`);
});
