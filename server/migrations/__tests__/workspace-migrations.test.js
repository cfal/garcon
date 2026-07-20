import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  cleanupLegacyQueueState,
  CURRENT_WORKSPACE_VERSION,
  WorkspaceMigrationRunner,
} from '../index.ts';

let workspaceDir;

beforeEach(async () => {
  workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'garcon-workspace-migrations-'));
});

afterEach(async () => {
  await fs.rm(workspaceDir, { recursive: true, force: true });
});

async function readVersion() {
  return JSON.parse(await fs.readFile(path.join(workspaceDir, 'workspace-version.json'), 'utf8'));
}

describe('WorkspaceMigrationRunner', () => {
  it('stamps a fresh workspace without running historical migrations', async () => {
    const migrate = mock(async () => undefined);
    const runner = await WorkspaceMigrationRunner.open(workspaceDir);

    await runner.run('chat-id-migration', migrate);
    await runner.run('core-record-migration', migrate);
    await runner.run('ephemeral-queue-state-cleanup', migrate);
    await runner.finish();

    expect(migrate).not.toHaveBeenCalled();
    expect(await readVersion()).toEqual({ version: CURRENT_WORKSPACE_VERSION });
  });

  it('runs old-workspace migrations in order before deleting ephemeral state', async () => {
    const queuesDir = path.join(workspaceDir, 'queues');
    await fs.mkdir(queuesDir);
    await Promise.all([
      fs.writeFile(path.join(workspaceDir, 'chats.json'), '{}', 'utf8'),
      fs.writeFile(path.join(queuesDir, 'chat-1.queue.json'), '{}', 'utf8'),
      fs.writeFile(path.join(workspaceDir, 'pending-user-inputs.json'), '{}', 'utf8'),
      fs.writeFile(path.join(workspaceDir, 'command-ledger.json'), '{}', 'utf8'),
    ]);
    const events = [];
    const runner = await WorkspaceMigrationRunner.open(workspaceDir);

    await runner.run('chat-id-migration', async () => { events.push('chat-id'); });
    await runner.run('core-record-migration', async () => { events.push('core-record'); });
    await runner.run('ephemeral-queue-state-cleanup', () => cleanupLegacyQueueState({
      workspaceDir,
      async settleOwnershipIntents() {
        expect(await fs.readFile(path.join(queuesDir, 'chat-1.queue.json'), 'utf8')).toBe('{}');
        events.push('ownership');
      },
    }));
    await runner.finish();

    expect(events).toEqual(['chat-id', 'core-record', 'ownership']);
    await expect(fs.stat(queuesDir)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.stat(path.join(workspaceDir, 'pending-user-inputs.json'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(fs.stat(path.join(workspaceDir, 'command-ledger.json'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(await readVersion()).toEqual({ version: CURRENT_WORKSPACE_VERSION });
  });

  it('runs only entries newer than the recorded version', async () => {
    await fs.writeFile(
      path.join(workspaceDir, 'workspace-version.json'),
      JSON.stringify({ version: 2 }),
      'utf8',
    );
    const early = mock(async () => undefined);
    const cleanup = mock(async () => undefined);
    const runner = await WorkspaceMigrationRunner.open(workspaceDir);

    await runner.run('chat-id-migration', early);
    await runner.run('core-record-migration', early);
    await runner.run('ephemeral-queue-state-cleanup', cleanup);
    await runner.finish();

    expect(early).not.toHaveBeenCalled();
    expect(cleanup).toHaveBeenCalledOnce();
    expect(await readVersion()).toEqual({ version: CURRENT_WORKSPACE_VERSION });
  });

  it('rejects invalid, future, and out-of-order workspace versions', async () => {
    await fs.writeFile(
      path.join(workspaceDir, 'workspace-version.json'),
      JSON.stringify({ version: CURRENT_WORKSPACE_VERSION + 1 }),
      'utf8',
    );
    await expect(WorkspaceMigrationRunner.open(workspaceDir)).rejects.toThrow('newer than supported');

    await fs.writeFile(
      path.join(workspaceDir, 'workspace-version.json'),
      JSON.stringify({ version: 0 }),
      'utf8',
    );
    const runner = await WorkspaceMigrationRunner.open(workspaceDir);
    await expect(runner.run('core-record-migration', async () => undefined)).rejects.toThrow(
      'expected chat-id-migration',
    );
  });
});
