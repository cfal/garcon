import { expect, test } from 'bun:test';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ReadTextResponse, SaveTextResponse } from '../../../common/file-contracts.js';
import { BULK_BACKENDS, observePending, waitForBulk, withBulkFixture } from '../../support/executor-bulk-fixture.js';
import { initializeFixtureRepository } from '../../support/git-fixture.js';

for (const backend of BULK_BACKENDS) {
  test(`bulk mutation recovery preserves native turns and never reapplies a completed save (${backend})`, async () => {
    await withBulkFixture('bulk-reconnect', backend, async (fixture, proxy, primary, initialBulk) => {
      const { client, fakeProviders, directAgents } = fixture;
      const projectPath = fixture.executionDirs.project;
      await initializeFixtureRepository(projectPath);
      const file = join(projectPath, 'file.txt');
      await writeFile(file, 'original');
      const route = `/api/v1/files/text?${new URLSearchParams({ executorId: client.executorId, projectPath, path: 'file.txt' })}`;
      let current = await client.get<ReadTextResponse>(route);
      const chatId = fixture.newChatId();
      const held = fakeProviders.openAi.holdNext({ lastUserText: 'Synthetic turn during bulk recovery' });
      const started = await client.startDirectChat({ chatId, projectPath, content: 'Synthetic turn during bulk recovery', agent: directAgents.openAi });
      await held.received;
      const cursor = client.markEvents();
      const requestDirection = backend === 'remote-controller-dials' ? 'toTarget' : 'fromTarget';
      const replyDirection = backend === 'remote-controller-dials' ? 'fromTarget' : 'toTarget';

      // Only part of the encrypted request reaches the worker before this socket ends.
      const beforeRequest = initialBulk.received[requestDirection];
      initialBulk.throttle(12 * 1024);
      const content = 'Synthetic partial save\n'.repeat(16_000);
      const first = observePending(client.put<SaveTextResponse>(route, {
        content, expectedRevision: current.revision, conflictResolution: 'reject',
      }));
      await initialBulk.waitForBytes(requestDirection, beforeRequest + 1024);
      expect(await readFile(file, 'utf8')).toBe('original');
      expect(first.settled).toBe(false);
      initialBulk.disconnect();
      expect((await first.result).revision).not.toBe(current.revision);
      expect(await readFile(file, 'utf8') === content).toBe(true);
      await waitForBulk(fixture);
      expect(primary.connected).toBe(true);
      expect(proxy.activeConnectionIds).toContain(primary.id);

      // A revision-checked retry would fail: success must come from the retained reply.
      current = await client.get<ReadTextResponse>(route);
      const replyBulk = proxy.capture(proxy.activeConnectionIds.find(id => id !== primary.id)!);
      const beforeReply = replyBulk.received[replyDirection];
      replyBulk.hold(replyDirection);
      const secondContent = 'Synthetic committed save with a lost reply';
      const second = observePending(client.put<SaveTextResponse>(route, {
        content: secondContent, expectedRevision: current.revision, conflictResolution: 'reject',
      }));
      await replyBulk.waitForBytes(replyDirection, beforeReply + 100);
      expect(await readFile(file, 'utf8')).toBe(secondContent);
      expect(second.settled).toBe(false);
      replyBulk.disconnect();
      const saved = await second.result;
      expect(saved.revision).not.toBe(current.revision);
      expect(await readFile(file, 'utf8')).toBe(secondContent);
      await waitForBulk(fixture);

      // Consuming a reply before its batched ACK is lost must not reapply the mutation.
      const ackBulk = proxy.capture(proxy.activeConnectionIds.find(id => id !== primary.id)!);
      const third = await client.put<SaveTextResponse>(route, {
        content: 'Synthetic acknowledged by caller', expectedRevision: saved.revision, conflictResolution: 'reject',
      });
      const beforeAck = ackBulk.received[requestDirection];
      ackBulk.hold(requestDirection);
      await ackBulk.waitForBytes(requestDirection, beforeAck + 40);
      ackBulk.disconnect();
      await waitForBulk(fixture);
      expect(await client.get<ReadTextResponse>(route)).toMatchObject({ content: 'Synthetic acknowledged by caller', revision: third.revision });
      expect(primary.connected).toBe(true);
      expect(await client.post('/api/v1/git/quick-summary', { executorId: client.executorId, project: projectPath })).toMatchObject({ status: 'ready' });
      expect(held.releaseText('Synthetic completion after three bulk failures')).toBe(true);
      expect(await client.waitForTurnTerminal(chatId, started.turnId, { afterIndex: cursor })).toMatchObject({ outcome: 'finished' });
      expect(client.eventsSince(cursor).filter(event => event.type === 'executors-changed'
        && event.executors.some(executor => executor.id === client.executorId && executor.availability !== 'ready'))).toEqual([]);
    });
  }, 120_000);
}
