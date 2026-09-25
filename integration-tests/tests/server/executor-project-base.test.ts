import { expect, test } from 'bun:test';
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ExecutorSnapshot } from '../../../common/executors.js';
import type { FileTreeResponse, ReadTextResponse } from '../../../common/file-contracts.js';
import type { ServerWsMessage } from '../../../common/ws-events.js';
import { withIntegrationFixture } from '../../support/integration-fixture.js';

for (const backend of ['remote-controller-dials', 'remote-executor-dials'] as const) {
  test(`worker base changes refresh metadata and enforce new boundaries without controller restart (${backend})`, async () => {
    await withIntegrationFixture(`project-base-${backend}`, async (fixture) => {
      const { client, executionDirs, dirs } = fixture;
      await client.put(`/api/v1/api-provider-assignments?executorId=local&apiProviderId=${fixture.directAgents.openAi.provider.providerId}`, {});
      const executorId = client.executorId;
      const pid = fixture.garcon.pid;
      const originalPath = executionDirs.project;
      const narrow = join(originalPath, 'narrow');
      await mkdir(narrow);
      await writeFile(join(originalPath, 'file.txt'), 'Synthetic outer file');
      await writeFile(join(narrow, 'inner.txt'), 'Synthetic inner file');
      await symlink(originalPath, join(narrow, 'escape'));
      const route = `/api/v1/files/text?${new URLSearchParams({ executorId, projectPath: originalPath, path: 'file.txt' })}`;
      const original = await client.get<ReadTextResponse>(route);
      const chatId = fixture.newChatId();
      const started = await client.startDirectChat({ chatId, projectPath: originalPath, content: 'Synthetic retained chat', agent: fixture.directAgents.openAi });
      await client.waitForTurnTerminal(chatId, started.turnId);
      const localChatId = fixture.newChatId();
      const held = fixture.fakeProviders.openAi.holdNext({ lastUserText: 'Synthetic unaffected local turn' });
      const local = await client.startDirectChat({ executorId: 'local', chatId: localChatId, projectPath: dirs.project, content: 'Synthetic unaffected local turn', agent: fixture.directAgents.openAi });
      await held.received;
      const snapshot = async () => (await client.get<{ executors: ExecutorSnapshot[] }>('/api/v1/executors')).executors.find((executor) => executor.id === executorId)!;
      let previous = await snapshot();
      const originalLocal = (await client.get<{ executors: ExecutorSnapshot[] }>('/api/v1/executors')).executors[0];
      for (const base of ['/', narrow]) {
        const eventIndex = client.eventRecords().length;
        await fixture.crashAndRestartExecutorWorker(base);
        const current = await snapshot();
        expect(current).toMatchObject({ projectBasePath: base, availability: 'ready', lastError: null });
        expect(current.instanceId).not.toBe(previous.instanceId);
        await client.waitForEvent(
          (event): event is Extract<ServerWsMessage, { type: 'executors-changed' }> => event.type === 'executors-changed' && event.executors.some((executor) => executor.id === executorId && executor.instanceId === current.instanceId && executor.projectBasePath === base),
          'accepted replacement metadata', { afterIndex: eventIndex },
        );
        expect((await client.getChatSnapshot(chatId)).chat).toMatchObject({ executorId, projectPath: originalPath });
        expect(fixture.garcon.pid).toBe(pid);
        const executors = (await client.get<{ executors: ExecutorSnapshot[] }>('/api/v1/executors')).executors;
        expect(executors[0]).toEqual(originalLocal);
        if (base === '/') {
          expect(await client.get<ReadTextResponse>(route)).toEqual(original);
          const tree = await client.get<FileTreeResponse>(`/api/v1/files/tree?${new URLSearchParams({ executorId, path: originalPath })}`);
          expect(tree.fileRootPath).toBe('/');
          expect(tree.directory.breadcrumbs[0]).toEqual({ name: '/', path: '/' });
          expect(await client.get(`/api/v1/projects/resolve?${new URLSearchParams({ executorId, projectPath: dirs.project })}`))
            .toMatchObject({ resolution: { kind: 'available' } });
          const continued = await client.runDirectChat({ chatId, content: 'Synthetic explicit followup', agent: fixture.directAgents.openAi });
          await client.waitForTurnTerminal(chatId, continued.turnId);
        } else {
          expect(await client.get(`/api/v1/projects/resolve?${new URLSearchParams({ executorId, projectPath: originalPath })}`))
            .toMatchObject({ resolution: { kind: 'unavailable', reason: 'outside-base' } });
          await expect(client.get(route)).rejects.toMatchObject({ status: 403 });
          await expect(client.put(route, { content: 'must not write', expectedRevision: original.revision, conflictResolution: 'overwrite' }))
            .rejects.toMatchObject({ status: 403 });
          const escape = `/api/v1/files/text?${new URLSearchParams({ executorId, projectPath: narrow, path: 'escape/file.txt' })}`;
          await expect(client.get(escape)).rejects.toMatchObject({ status: 403 });
          const inner = `/api/v1/files/text?${new URLSearchParams({ executorId, projectPath: narrow, path: 'inner.txt' })}`;
          expect(await client.get(inner)).toMatchObject({ content: 'Synthetic inner file' });
          expect(await readFile(join(originalPath, 'file.txt'), 'utf8')).toBe(original.content);
        }
        previous = current;
      }
      expect(held.releaseText('Synthetic uninterrupted local result')).toBe(true);
      expect(await client.waitForTurnTerminal(localChatId, local.turnId)).toMatchObject({ type: 'agent-run-finished' });
    }, { executionBackend: backend, projectRoots: 'separate' });
  }, 60_000);
}
