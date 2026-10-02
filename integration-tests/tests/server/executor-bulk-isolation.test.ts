import { expect, test } from 'bun:test';
import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { discoverRuntime } from '../../../cli/discovery.js';
import { GarconClient } from '../../../cli/garcon-client.js';
import type { ExecutionGitResults } from '../../../common/git-execution.js';
import type { ExecutorSnapshot } from '../../../common/executors.js';
import type { ReadTextResponse } from '../../../common/file-contracts.js';
import type { ChatDetailsResponse } from '../../../common/chat-details.js';
import type { TerminalCreateResponse, TerminalListResponse, TerminalStreamServerMessage } from '../../../common/terminal.js';
import { initializeFixtureRepository } from '../../support/git-fixture.js';
import { BULK_BACKENDS, observePending, withBulkFixture } from '../../support/executor-bulk-fixture.js';

for (const backend of BULK_BACKENDS) {
  test(`held Files, Git, history and reverse CLI leave eight active turns and primary controls responsive (${backend})`, async () => {
    await withBulkFixture('bulk-isolation', backend, async (fixture, proxy, primary, bulk) => {
      const { client, directAgents, fakeProviders } = fixture;
      const executorId = client.executorId;
      const project = fixture.executionDirs.project;
      await initializeFixtureRepository(project);
      const content = 'f'.repeat(4 * 1024 * 1024);
      const changed = Array.from({ length: 8_000 }, (_, index) => `synthetic change ${index} ${'x'.repeat(80)}\n`).join('');
      await writeFile(join(project, 'payload.txt'), content);
      await writeFile(join(project, 'example.txt'), changed);
      const snapshot = await client.post<ExecutionGitResults['getWorkbenchSnapshot']>('/api/v1/git/workbench/snapshot', {
        executorId, project, mode: 'working', context: 3,
      });
      if (snapshot.status !== 'ready') throw new Error('Expected review snapshot');
      const document = { executorId, instanceId: snapshot.instanceId, documentId: snapshot.reviewSummary.documentId };

      const historyId = fixture.newChatId();
      const seed = await client.startDirectChat({ chatId: historyId, projectPath: project, content: 'Synthetic history seed', agent: directAgents.openAi });
      await client.waitForTurnTerminal(historyId, seed.turnId);
      const nativeRows = Array.from({ length: 25 }, (_, index) => {
        const at = new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString();
        const runId = `synthetic-bulk-history-${index}`;
        return [
          JSON.stringify({ type: 'user', at, runId, content: `Synthetic request ${index}`, attachments: [] }),
          JSON.stringify({ type: 'assistant', at, runId,
            content: `Synthetic row ${index}: ${'h'.repeat(index === 0 ? 1100 * 1024 : 128 * 1024)}`, checkpoint: null }),
        ];
      }).flat();
      const details = await client.get<ChatDetailsResponse>(`/api/v1/chats/details?chatId=${historyId}`);
      if (details.transcriptSource?.kind !== 'filesystem-path') throw new Error('Expected native history path');
      const existing = await readFile(details.transcriptSource.value);
      const separator = existing.at(-1) === 0x0a ? '' : '\n';
      await appendFile(details.transcriptSource.value, `${separator}${nativeRows.join('\n')}\n`);
      const seeded = await client.reloadChat(historyId);
      expect(seeded.lastOrdinal).toBeGreaterThanOrEqual(25);
      await client.patch(`/api/v1/executors/${executorId}`, { allowControllerCli: true });
      const cli = new GarconClient(await discoverRuntime({ configDir: fixture.executionDirs.config, runtime: 'executor' }));

      const turns = [];
      for (let index = 0; index < 8; index++) {
        const chatId = fixture.newChatId();
        const prompt = `Synthetic held turn ${index}`;
        const held = fakeProviders.openAi.holdNext({ lastUserText: prompt });
        const accepted = await client.startDirectChat({ chatId, projectPath: project, content: prompt, agent: directAgents.openAi });
        await held.received;
        turns.push({ chatId, accepted, held });
      }

      const inventory = await client.get<TerminalListResponse>(`/api/v1/terminals?executorId=${executorId}`);
      const { terminal } = await client.post<TerminalCreateResponse>('/api/v1/terminals', {
        executorId, expectedTerminalRuntimeId: inventory.terminalRuntimeId, requestId: 'synthetic-bulk-terminal', requestedInitialWorkingDirectory: project,
      });
      const attachmentId = crypto.randomUUID();
      client.sendTerminal({ type: 'terminal-attach', terminalId: terminal.terminalId, attachmentId,
        attachmentEpoch: inventory.attachmentEpoch, clientId: 'synthetic-browser', afterSequence: 0, intent: 'restore' });
      await client.waitForEvent((event): event is Extract<TerminalStreamServerMessage, { type: 'terminal-attached' }> =>
        event.type === 'terminal-attached' && event.attachmentId === attachmentId, 'primary terminal attached');

      const cursor = client.markEvents();
      const before = bulk.received;
      bulk.hold();
      const file = observePending(client.get<ReadTextResponse>(`/api/v1/files/text?${new URLSearchParams({ executorId, projectPath: project, path: 'payload.txt' })}`));
      const review = observePending(client.post<ExecutionGitResults['getReviewDocumentFileBodies']>('/api/v1/git/review-documents/files', {
        executorId, project, document, files: ['example.txt'], purpose: 'visible',
      }));
      const history = observePending(client.reloadChat(historyId));
      const exported = observePending(cli.getTranscriptExport({ chatId: historyId, format: 'markdown', exclusions: [] }));
      await Promise.all([
        bulk.waitForBytes('toTarget', before.toTarget + 100),
        bulk.waitForBytes('fromTarget', before.fromTarget + 100),
      ]);

      await client.ping();
      expect(await cli.verifyRuntime()).toBe(true);
      expect(await cli.getTurnReceipt(turns[0]!.chatId, turns[0]!.accepted.turnId)).toMatchObject({ state: 'pending' });
      expect(await client.post('/api/v1/git/quick-summary', { executorId, project })).toMatchObject({ status: 'ready' });
      expect(await cli.stopChat({ chatId: turns[0]!.chatId, clientRequestId: crypto.randomUUID() }))
        .toMatchObject({ outcome: 'interrupt-requested' });
      await turns[0]!.held.expectAbort();
      expect(await client.waitForTurnTerminal(turns[0]!.chatId, turns[0]!.accepted.turnId, { afterIndex: cursor }))
        .toMatchObject({ outcome: 'interrupted' });
      for (const turn of turns.slice(1)) expect(turn.held.releaseText('Synthetic primary progress')).toBe(true);
      for (const turn of turns.slice(1)) expect(await client.waitForTurnTerminal(turn.chatId, turn.accepted.turnId, { afterIndex: cursor }))
        .toMatchObject({ type: 'agent-run-finished', outcome: 'finished' });

      client.sendTerminal({ type: 'terminal-input', terminalId: terminal.terminalId, attachmentId,
        data: "stty -echo; printf '\\033[32mprimary-progress\\033[0m\\n'\r" });
      await client.waitForEvent((event): event is Extract<TerminalStreamServerMessage, { type: 'terminal-output' }> =>
        event.type === 'terminal-output' && event.attachmentId === attachmentId && event.data.includes('\u001b[32mprimary-progress'),
      'terminal output while bulk is held', { afterIndex: cursor });
      const freshId = fixture.newChatId();
      const fresh = await client.startDirectChat({ chatId: freshId, projectPath: project, content: 'Synthetic new admission while bulk is held', agent: directAgents.openAi });
      expect(await client.waitForTurnTerminal(freshId, fresh.turnId)).toMatchObject({ outcome: 'finished' });
      expect([file, review, history, exported].map(pending => pending.settled)).toEqual([false, false, false, false]);
      expect(primary.connected).toBe(true);
      expect(proxy.connections).toBe(2);

      bulk.restore();
      expect((await file.result).content === content).toBe(true);
      const bodies = await review.result;
      if (bodies.status !== 'ready') throw new Error('Expected review bodies');
      expect(bodies.files['example.txt'].patch).toContain('+synthetic change 7999 ');
      expect((await history.result).lastOrdinal).toBe(seeded.lastOrdinal);
      expect((await exported.result).document.length).toBeGreaterThan(4 * 1024 * 1024);
      const { executors } = await client.get<{ executors: ExecutorSnapshot[] }>('/api/v1/executors');
      expect(executors.find(executor => executor.id === executorId)).toMatchObject({ availability: 'ready', bulk: { availability: 'ready' } });
      expect(client.eventsSince(cursor).filter(event => event.type === 'executors-changed'
        && event.executors.some(executor => executor.id === executorId && executor.availability !== 'ready'))).toEqual([]);

      // Reverse bulk RPC can invoke forward primary work without holding its reply lane.
      const forkId = fixture.newChatId();
      expect((await cli.forkChat({ sourceChatId: historyId, chatId: forkId })).chat.id).toBe(forkId);
      expect((await client.getMessages(forkId)).lastOrdinal).toBeGreaterThanOrEqual(25);
      await client.delete('/api/v1/terminals', { terminalId: terminal.terminalId, requestId: 'synthetic-bulk-terminal-close' });
    });
  }, 120_000);
}
