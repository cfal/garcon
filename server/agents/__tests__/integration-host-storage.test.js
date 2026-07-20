import { afterEach, describe, expect, test } from 'bun:test';
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AgentIntegrationError } from '@garcon/server-agent-interface';
import { IntegrationHostFactory } from '../integration-host.ts';

const createdDirectories = [];

async function createStorage() {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), 'garcon-agent-storage-'));
  createdDirectories.push(workspaceDir);
  const factory = new IntegrationHostFactory({
    workspaceDir,
    resolveCredential: async () => null,
    loadCarryOver: async ({ expectedRevision }) => ({ revision: expectedRevision, messages: [] }),
    loggerFactory: () => ({ debug() {}, info() {}, warn() {}, error() {} }),
  });
  return { storage: factory.forAgent('alpha').storage, workspaceDir };
}

async function expectAbsent(candidate) {
  await expect(access(candidate)).rejects.toMatchObject({ code: 'ENOENT' });
}

describe('IntegrationHostFactory legacy storage claims', () => {
  afterEach(async () => {
    for (const directory of createdDirectories.splice(0)) {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test('moves a nested legacy directory into agent-scoped storage', async () => {
    const { storage, workspaceDir } = await createStorage();
    const source = path.join(workspaceDir, 'legacy-sessions');
    await mkdir(path.join(source, 'endpoint'), { recursive: true });
    await writeFile(path.join(source, 'root.jsonl'), 'root');
    await writeFile(path.join(source, 'endpoint', 'nested.jsonl'), 'nested');

    await expect(storage.claimLegacyWorkspaceDirectory('legacy-sessions')).resolves.toEqual({
      moved: 2,
      skipped: 0,
    });
    const destination = path.join(storage.rootDirectory, 'legacy-sessions');
    await expect(readFile(path.join(destination, 'root.jsonl'), 'utf8')).resolves.toBe('root');
    await expect(readFile(path.join(destination, 'endpoint', 'nested.jsonl'), 'utf8')).resolves.toBe('nested');
    await expectAbsent(source);
  });

  test('does nothing when the legacy directory is absent', async () => {
    const { storage } = await createStorage();

    await expect(storage.claimLegacyWorkspaceDirectory('legacy-sessions')).resolves.toEqual({
      moved: 0,
      skipped: 0,
    });
  });

  test('leaves an existing destination file and its legacy copy untouched', async () => {
    const { storage, workspaceDir } = await createStorage();
    const sourceFile = path.join(workspaceDir, 'legacy-sessions', 'session.jsonl');
    const destinationFile = path.join(storage.rootDirectory, 'legacy-sessions', 'session.jsonl');
    await mkdir(path.dirname(sourceFile), { recursive: true });
    await mkdir(path.dirname(destinationFile), { recursive: true });
    await writeFile(sourceFile, 'legacy');
    await writeFile(destinationFile, 'current');

    await expect(storage.claimLegacyWorkspaceDirectory('legacy-sessions')).resolves.toEqual({
      moved: 0,
      skipped: 1,
    });
    await expect(readFile(sourceFile, 'utf8')).resolves.toBe('legacy');
    await expect(readFile(destinationFile, 'utf8')).resolves.toBe('current');
  });

  test('completes the remainder after a partially completed claim', async () => {
    const { storage, workspaceDir } = await createStorage();
    const source = path.join(workspaceDir, 'legacy-sessions');
    const destination = path.join(storage.rootDirectory, 'legacy-sessions');
    await mkdir(path.join(source, 'endpoint'), { recursive: true });
    await mkdir(path.join(destination, 'endpoint'), { recursive: true });
    await writeFile(path.join(source, 'endpoint', 'remaining.jsonl'), 'remaining');
    await writeFile(path.join(destination, 'endpoint', 'moved.jsonl'), 'moved');

    await expect(storage.claimLegacyWorkspaceDirectory('legacy-sessions')).resolves.toEqual({
      moved: 1,
      skipped: 0,
    });
    await expect(readFile(path.join(destination, 'endpoint', 'moved.jsonl'), 'utf8')).resolves.toBe('moved');
    await expect(readFile(path.join(destination, 'endpoint', 'remaining.jsonl'), 'utf8')).resolves.toBe('remaining');
    await expectAbsent(source);
  });

  test('skips symlinked entries without traversing them', async () => {
    const { storage, workspaceDir } = await createStorage();
    const source = path.join(workspaceDir, 'legacy-sessions');
    const outside = path.join(workspaceDir, 'outside');
    await mkdir(source);
    await mkdir(outside);
    await writeFile(path.join(outside, 'session.jsonl'), 'outside');
    await symlink(outside, path.join(source, 'linked'));

    await expect(storage.claimLegacyWorkspaceDirectory('legacy-sessions')).resolves.toEqual({
      moved: 0,
      skipped: 1,
    });
    await expect(readFile(path.join(outside, 'session.jsonl'), 'utf8')).resolves.toBe('outside');
    await expectAbsent(path.join(storage.rootDirectory, 'legacy-sessions', 'linked'));
  });

  test('rejects unsafe names and symlinked legacy directories', async () => {
    const { storage, workspaceDir } = await createStorage();
    await expect(storage.claimLegacyWorkspaceDirectory('../evil')).rejects.toBeInstanceOf(
      AgentIntegrationError,
    );
    const outside = path.join(workspaceDir, 'outside');
    await mkdir(outside);
    await symlink(outside, path.join(workspaceDir, 'legacy-sessions'));

    await expect(storage.claimLegacyWorkspaceDirectory('legacy-sessions')).rejects.toBeInstanceOf(
      AgentIntegrationError,
    );
  });
});
