import { expect, test } from 'bun:test';
import { chmod, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { DirectoryEntry, ReadTextResponse, SaveTextResponse, FileIdentityResponse } from '../../../common/file-contracts.js';
import { MAX_FILE_VIEW_BYTES } from '../../../common/file-contracts.js';
import type { ExecutorSnapshot } from '../../../common/executors.js';
import { withIntegrationFixture } from '../../support/integration-fixture.js';
import { descriptorPathsDirectory } from '../../../server/runtime/files/directory-creation.js';
import { rejectionOf } from '../../support/promise-assertions.js';

for (const backend of ['remote-controller-dials', 'remote-executor-dials'] as const) {
  test(`oversized save revisions leave the shared executor connection and running chat intact (${backend})`, async () => {
    await withIntegrationFixture(`files-revision-limit-${backend}`, async (fixture) => {
      const { client } = fixture;
      const executorId = client.executorId;
      const projectPath = fixture.executionDirs.project;
      const file = join(projectPath, 'file.txt');
      await writeFile(file, 'original');
      const route = `/api/v1/files/text?${new URLSearchParams({ executorId, projectPath, path: 'file.txt' })}`;
      const before = await client.get<ReadTextResponse>(route);
      const chatId = fixture.newChatId();
      const held = fixture.fakeProviders.openAi.holdNext({ model: fixture.directAgents.openAi.provider.model });
      const started = await client.startDirectChat({
        chatId, content: 'Synthetic shared-channel turn', projectPath, agent: fixture.directAgents.openAi,
      });
      await held.received;
      const eventIndex = client.eventRecords().length;
      expect(await rejectionOf(client.put(route, {
        content: 'x', expectedRevision: `v1:${'a'.repeat(17 * 1024 * 1024)}`, conflictResolution: 'overwrite',
      }))).toMatchObject({ status: 400, body: { errorCode: 'VALIDATION_FAILED' } });
      expect(await readFile(file, 'utf8')).toBe('original');
      const { executors } = await client.get<{ executors: ExecutorSnapshot[] }>('/api/v1/executors');
      expect(executors.find((executor) => executor.id === executorId)?.availability).toBe('ready');
      expect(await client.get<ReadTextResponse>(route)).toEqual(before);
      await client.put(route, { content: 'valid save', expectedRevision: before.revision, conflictResolution: 'reject' });
      expect(await readFile(file, 'utf8')).toBe('valid save');
      expect(held.releaseText('Synthetic uninterrupted response')).toBe(true);
      expect(await client.waitForTurnTerminal(chatId, started.turnId)).toMatchObject({ type: 'agent-run-finished' });
      const unavailable = client.eventRecords().slice(eventIndex).filter(({ parsed }) =>
        parsed.type === 'executors-changed'
        && parsed.executors.some((executor) => executor.id === executorId && executor.availability !== 'ready'));
      expect(unavailable).toEqual([]);
    }, { executionBackend: backend, projectRoots: 'separate' });
  }, 60_000);

  test(`file HTTP operations use the selected worker (${backend})`, async () => {
    await withIntegrationFixture(`files-${backend}`, async (fixture) => {
      const { client } = fixture;
      const executorId = client.executorId;
      const projectPath = fixture.executionDirs.project;
      await mkdir(join(projectPath, 'folder'));
      const privateDirectory = join(projectPath, 'private');
      await mkdir(privateDirectory);
      await chmod(privateDirectory, 0);
      const content = 'x'.repeat(MAX_FILE_VIEW_BYTES - 5);
      await writeFile(join(projectPath, 'file.txt'), content);
      await writeFile(join(fixture.dirs.project, 'file.txt'), 'controller file');
      const query = new URLSearchParams({ executorId, projectPath, path: 'file.txt' });
      const result = await client.get<ReadTextResponse>(`/api/v1/files/text?${query}`);
      expect(result.content === content).toBe(true);
      const identity = await client.get<FileIdentityResponse>(`/api/v1/files/identity?${query}`);
      try {
        const listed = await client.get<Array<{ name: string }>>(`/api/v1/files/list?${query}`);
        expect(listed.some((file) => file.name === 'file.txt')).toBe(true);
      } finally { await chmod(privateDirectory, 0o700); }
      expect(identity.identity).toMatchObject({ executorId, canonicalFileRootPath: projectPath, normalizedRelativePath: 'file.txt' });
      expect(await client.get<Array<{ name: string; path: string; type: string }>>(`/api/v1/files/browse?executorId=${executorId}&path=${encodeURIComponent(projectPath)}`)).toContainEqual({ name: 'folder', path: join(projectPath, 'folder'), type: 'directory' });
      const saved = await client.put<SaveTextResponse>(`/api/v1/files/text?${query}`, { content: `${content}saved`, expectedRevision: result.revision, conflictResolution: 'reject' });
      expect(saved.revision).not.toBe(result.revision);
      expect((await readFile(join(projectPath, 'file.txt'), 'utf8')) === `${content}saved`).toBe(true);
      expect(await readFile(join(fixture.dirs.project, 'file.txt'), 'utf8')).toBe('controller file');
      expect(await rejectionOf(client.put(`/api/v1/files/text?${query}`, { content: 'stale', expectedRevision: result.revision, conflictResolution: 'reject' }))).toMatchObject({ status: 409, body: { errorCode: 'FILE_REVISION_CONFLICT' } });
      expect(await rejectionOf(client.put(`/api/v1/files/text?${query}`, { content: 'x'.repeat(MAX_FILE_VIEW_BYTES + 1), expectedRevision: saved.revision, conflictResolution: 'reject' }))).toMatchObject({ status: 413, body: { errorCode: 'FILE_TOO_LARGE' } });
      expect(await readFile(join(projectPath, 'file.txt'), 'utf8')).toBe(`${content}saved`);
      await writeFile(join(projectPath, 'large.txt'), 'x'.repeat(MAX_FILE_VIEW_BYTES + 1));
      const oversized = new URLSearchParams({ executorId, projectPath, path: 'large.txt' });
      expect(await rejectionOf(client.get(`/api/v1/files/text?${oversized}`))).toMatchObject({ status: 413, body: { errorCode: 'FILE_TOO_LARGE' } });
      const wrongRoot = new URLSearchParams({ executorId, projectPath: fixture.dirs.project, path: 'file.txt' });
      expect(await rejectionOf(client.get(`/api/v1/files/text?${wrongRoot}`))).toMatchObject({ status: 403 });
      await fixture.crashAndRestartGarcon({ preserveExecutorWorker: true });
      const restarted = await fixture.client.get<ReadTextResponse>(`/api/v1/files/text?${query}`);
      expect(restarted.content === `${content}saved`).toBe(true);
      const crowded = join(projectPath, 'crowded');
      await mkdir(join(crowded, 'selectable-project'), { recursive: true });
      for (let i = 0; i < 1800; i++) await writeFile(join(crowded, `${i}-${'x'.repeat(220)}`), '');
      expect(await rejectionOf(fixture.client.get(`/api/v1/files/tree?executorId=${executorId}&path=${encodeURIComponent(crowded)}`))).toMatchObject({ status: 413, body: { errorCode: 'FILE_LIST_TOO_LARGE' } });
      expect(await fixture.client.get<Array<{ name: string; path: string; type: string }>>(`/api/v1/files/browse?executorId=${executorId}&path=${encodeURIComponent(crowded)}`)).toEqual([
        { name: 'selectable-project', path: join(crowded, 'selectable-project'), type: 'directory' },
      ]);
    }, { executionBackend: backend, projectRoots: 'separate' });
  }, 60_000);

  test(`directory creation runs on the selected executor and never falls back to Local (${backend})`, async () => {
    await withIntegrationFixture(`files-create-directory-${backend}`, async (fixture) => {
      const executorId = fixture.client.executorId;
      const workerBase = fixture.executionDirs.project;
      const controllerBase = fixture.dirs.project;
      const route = (target: string, path: string) => `/api/v1/files/directories?${new URLSearchParams({ executorId: target, path })}`;
      const create = (target: string, path: string, name: unknown) => fixture.client.post<DirectoryEntry>(route(target, path), { name });
      // The controller and worker run on this machine, so both detect what this process detects.
      const supported = descriptorPathsDirectory() !== null;
      const reported = await fixture.client.get<{ executors: ExecutorSnapshot[] }>('/api/v1/executors');
      expect(reported.executors.map((executor) => executor.machineServices.directoryCreation)).toEqual([supported, supported]);
      if (!supported) {
        for (const [target, base] of [[executorId, workerBase], ['local', controllerBase]] as const) {
          expect(await rejectionOf(create(target, base, 'shared name'))).toMatchObject({ status: 501, body: { errorCode: 'OPERATION_UNSUPPORTED' } });
          expect(await readdir(base)).toEqual([]);
        }
        return;
      }

      expect(await create(executorId, workerBase, 'shared name')).toEqual({ name: 'shared name', path: join(workerBase, 'shared name'), type: 'directory' });
      expect(await readdir(workerBase)).toEqual(['shared name']);
      expect(await readdir(controllerBase)).toEqual([]);
      expect(await create('local', controllerBase, 'shared name')).toEqual({ name: 'shared name', path: join(controllerBase, 'shared name'), type: 'directory' });
      expect(await create(executorId, join(workerBase, 'shared name'), 'nested')).toMatchObject({ path: join(workerBase, 'shared name', 'nested') });
      expect(await readdir(join(controllerBase, 'shared name'))).toEqual([]);
      expect(await fixture.client.get<DirectoryEntry[]>(`/api/v1/files/browse?${new URLSearchParams({ executorId, path: join(workerBase, 'shared name') })}`))
        .toEqual([{ name: 'nested', path: join(workerBase, 'shared name', 'nested'), type: 'directory' }]);

      expect(await rejectionOf(create(executorId, workerBase, 'shared name'))).toMatchObject({ status: 409, body: { errorCode: 'FILE_ALREADY_EXISTS' } });
      expect(await rejectionOf(create(executorId, workerBase, '../escape'))).toMatchObject({ status: 400, body: { errorCode: 'VALIDATION_FAILED' } });
      expect(await rejectionOf(create(executorId, join(workerBase, 'absent'), 'child'))).toMatchObject({ status: 404, body: { errorCode: 'FILE_NOT_FOUND' } });
      // Each base belongs to one executor, so the other rejects it instead of creating there.
      expect(await rejectionOf(create(executorId, controllerBase, 'crossed'))).toMatchObject({ status: 403, body: { errorCode: 'FILE_OUTSIDE_ROOT' } });
      expect(await rejectionOf(create('local', workerBase, 'crossed'))).toMatchObject({ status: 403, body: { errorCode: 'FILE_OUTSIDE_ROOT' } });
      expect(await rejectionOf(create('99999999-9999-4999-8999-999999999999', controllerBase, 'unknown executor'))).toMatchObject({ status: 503, body: { errorCode: 'EXECUTOR_UNAVAILABLE' } });
      expect(await readdir(controllerBase)).toEqual(['shared name']);

      await fixture.crashAndRestartGarcon({ preserveExecutorWorker: true });
      expect(await fixture.client.post<DirectoryEntry>(route(executorId, workerBase), { name: 'after restart' }))
        .toEqual({ name: 'after restart', path: join(workerBase, 'after restart'), type: 'directory' });
      expect((await readdir(workerBase)).sort()).toEqual(['after restart', 'shared name']);
      expect(await readdir(controllerBase)).toEqual(['shared name']);
      const { executors } = await fixture.client.get<{ executors: ExecutorSnapshot[] }>('/api/v1/executors');
      expect(executors.find((executor) => executor.id === executorId)?.availability).toBe('ready');
      expect(executors.map((executor) => executor.machineServices.directoryCreation)).toEqual([supported, supported]);
    }, { executionBackend: backend, projectRoots: 'separate' });
  }, 60_000);
}
