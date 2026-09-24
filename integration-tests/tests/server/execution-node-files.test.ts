import { expect, test } from 'bun:test';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ReadTextResponse, SaveTextResponse, FileIdentityResponse } from '../../../common/file-contracts.js';
import { MAX_FILE_VIEW_BYTES } from '../../../common/file-contracts.js';
import type { ExecutionNodeSnapshot } from '../../../common/execution-nodes.js';
import { withIntegrationFixture } from '../../support/integration-fixture.js';

for (const backend of ['remote-controller-dials', 'remote-node-dials'] as const) {
  test(`oversized save revisions leave the shared node connection and running chat intact (${backend})`, async () => {
    await withIntegrationFixture(`files-revision-limit-${backend}`, async (fixture) => {
      const { client } = fixture;
      const nodeId = client.nodeId;
      const projectPath = fixture.executionDirs.project;
      const file = join(projectPath, 'file.txt');
      await writeFile(file, 'original');
      const route = `/api/v1/files/text?${new URLSearchParams({ nodeId, projectPath, path: 'file.txt' })}`;
      const before = await client.get<ReadTextResponse>(route);
      const chatId = fixture.newChatId();
      const held = fixture.fakeProviders.openAi.holdNext({ model: fixture.directAgents.openAi.provider.model });
      const started = await client.startDirectChat({
        chatId, content: 'Synthetic shared-channel turn', projectPath, agent: fixture.directAgents.openAi,
      });
      await held.received;
      const eventIndex = client.eventRecords().length;
      await expect(client.put(route, {
        content: 'x', expectedRevision: `v1:${'a'.repeat(17 * 1024 * 1024)}`, conflictResolution: 'overwrite',
      })).rejects.toMatchObject({ status: 400, body: { errorCode: 'VALIDATION_FAILED' } });
      expect(await readFile(file, 'utf8')).toBe('original');
      const { nodes } = await client.get<{ nodes: ExecutionNodeSnapshot[] }>('/api/v1/execution-nodes');
      expect(nodes.find((node) => node.id === nodeId)?.availability).toBe('ready');
      expect(await client.get<ReadTextResponse>(route)).toEqual(before);
      await client.put(route, { content: 'valid save', expectedRevision: before.revision, conflictResolution: 'reject' });
      expect(await readFile(file, 'utf8')).toBe('valid save');
      expect(held.releaseText('Synthetic uninterrupted response')).toBe(true);
      expect(await client.waitForTurnTerminal(chatId, started.turnId)).toMatchObject({ type: 'agent-run-finished' });
      const unavailable = client.eventRecords().slice(eventIndex).filter(({ parsed }) =>
        parsed.type === 'execution-nodes-changed'
        && parsed.nodes.some((node) => node.id === nodeId && node.availability !== 'ready'));
      expect(unavailable).toEqual([]);
    }, { executionBackend: backend, projectRoots: 'separate' });
  }, 60_000);

  test(`file HTTP operations use the selected worker (${backend})`, async () => {
    await withIntegrationFixture(`files-${backend}`, async (fixture) => {
      const { client } = fixture;
      const nodeId = client.nodeId;
      const projectPath = fixture.executionDirs.project;
      await mkdir(join(projectPath, 'folder'));
      const privateDirectory = join(projectPath, 'private');
      await mkdir(privateDirectory);
      await chmod(privateDirectory, 0);
      const content = 'x'.repeat(MAX_FILE_VIEW_BYTES - 5);
      await writeFile(join(projectPath, 'file.txt'), content);
      await writeFile(join(fixture.dirs.project, 'file.txt'), 'controller file');
      const query = new URLSearchParams({ nodeId, projectPath, path: 'file.txt' });
      const result = await client.get<ReadTextResponse>(`/api/v1/files/text?${query}`);
      expect(result.content === content).toBe(true);
      const identity = await client.get<FileIdentityResponse>(`/api/v1/files/identity?${query}`);
      try {
        const listed = await client.get<Array<{ name: string }>>(`/api/v1/files/list?${query}`);
        expect(listed.some((file) => file.name === 'file.txt')).toBe(true);
      } finally { await chmod(privateDirectory, 0o700); }
      expect(identity.identity).toMatchObject({ nodeId, canonicalFileRootPath: projectPath, normalizedRelativePath: 'file.txt' });
      expect(await client.get<Array<{ name: string; path: string; type: string }>>(`/api/v1/files/browse?nodeId=${nodeId}&path=${encodeURIComponent(projectPath)}`)).toContainEqual({ name: 'folder', path: join(projectPath, 'folder'), type: 'directory' });
      const saved = await client.put<SaveTextResponse>(`/api/v1/files/text?${query}`, { content: `${content}saved`, expectedRevision: result.revision, conflictResolution: 'reject' });
      expect(saved.revision).not.toBe(result.revision);
      expect((await readFile(join(projectPath, 'file.txt'), 'utf8')) === `${content}saved`).toBe(true);
      expect(await readFile(join(fixture.dirs.project, 'file.txt'), 'utf8')).toBe('controller file');
      await expect(client.put(`/api/v1/files/text?${query}`, { content: 'stale', expectedRevision: result.revision, conflictResolution: 'reject' })).rejects.toMatchObject({ status: 409, body: { errorCode: 'FILE_REVISION_CONFLICT' } });
      await expect(client.put(`/api/v1/files/text?${query}`, { content: 'x'.repeat(MAX_FILE_VIEW_BYTES + 1), expectedRevision: saved.revision, conflictResolution: 'reject' }))
        .rejects.toMatchObject({ status: 413, body: { errorCode: 'FILE_TOO_LARGE' } });
      expect(await readFile(join(projectPath, 'file.txt'), 'utf8')).toBe(`${content}saved`);
      await writeFile(join(projectPath, 'large.txt'), 'x'.repeat(MAX_FILE_VIEW_BYTES + 1));
      const oversized = new URLSearchParams({ nodeId, projectPath, path: 'large.txt' });
      await expect(client.get(`/api/v1/files/text?${oversized}`))
        .rejects.toMatchObject({ status: 413, body: { errorCode: 'FILE_TOO_LARGE' } });
      const wrongRoot = new URLSearchParams({ nodeId, projectPath: fixture.dirs.project, path: 'file.txt' });
      await expect(client.get(`/api/v1/files/text?${wrongRoot}`)).rejects.toMatchObject({ status: 403 });
      await fixture.crashAndRestartGarcon({ preserveExecutionWorker: true });
      const restarted = await fixture.client.get<ReadTextResponse>(`/api/v1/files/text?${query}`);
      expect(restarted.content === `${content}saved`).toBe(true);
      const crowded = join(projectPath, 'crowded');
      await mkdir(join(crowded, 'selectable-project'), { recursive: true });
      for (let i = 0; i < 1800; i++) await writeFile(join(crowded, `${i}-${'x'.repeat(220)}`), '');
      await expect(fixture.client.get(`/api/v1/files/tree?nodeId=${nodeId}&path=${encodeURIComponent(crowded)}`))
        .rejects.toMatchObject({ status: 413, body: { errorCode: 'FILE_LIST_TOO_LARGE' } });
      expect(await fixture.client.get<Array<{ name: string; path: string; type: string }>>(`/api/v1/files/browse?nodeId=${nodeId}&path=${encodeURIComponent(crowded)}`)).toEqual([
        { name: 'selectable-project', path: join(crowded, 'selectable-project'), type: 'directory' },
      ]);
    }, { executionBackend: backend, projectRoots: 'separate' });
  }, 60_000);
}
