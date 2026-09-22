import { expect, test } from 'bun:test';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ExecutionGitResults } from '../../../common/git-execution.js';
import type { ReadTextResponse } from '../../../common/file-contracts.js';
import type { ExecutionNodeSnapshot } from '../../../common/execution-nodes.js';
import type { TerminalCreateResponse, TerminalListResponse, TerminalStreamServerMessage } from '../../../common/terminal.js';
import { withIntegrationFixture } from '../../support/integration-fixture.js';
import { initializeFixtureRepository } from '../../support/git-fixture.js';

for (const executionBackend of ['remote-controller-dials', 'remote-node-dials'] as const) {
  test(`Git bodies coexist with Files, PTY output and chat on the shared channel (${executionBackend})`, async () => {
    await withIntegrationFixture(`git-shared-channel-${executionBackend}`, async fixture => {
      const { client, executionDirs, directAgents } = fixture;
      const nodeId = client.nodeId;
      const project = executionDirs.project;
      await initializeFixtureRepository(project);
      const changed = Array.from({ length: 8_000 }, (_, index) => `synthetic change ${index} ${'x'.repeat(80)}\n`).join('');
      const content = 'Synthetic file payload\n'.repeat(100_000);
      await writeFile(join(project, 'example.txt'), changed);
      await writeFile(join(project, 'payload.txt'), content);
      const snapshot = await client.post<ExecutionGitResults['getWorkbenchSnapshot']>('/api/v1/git/workbench/snapshot', {
        nodeId, project, mode: 'working', context: 3,
      });
      if (snapshot.status !== 'ready') throw new Error('Expected review snapshot');
      const document = { nodeId, instanceId: snapshot.instanceId, documentId: snapshot.reviewSummary.documentId };
      const inventory = await client.get<TerminalListResponse>(`/api/v1/terminals?nodeId=${nodeId}`);
      const { terminal } = await client.post<TerminalCreateResponse>('/api/v1/terminals', {
        nodeId, expectedTerminalRuntimeId: inventory.terminalRuntimeId,
        requestId: 'synthetic-shared-channel-terminal', requestedInitialWorkingDirectory: project,
      });
      const terminalId = terminal.terminalId;
      const attachmentId = crypto.randomUUID();
      client.sendTerminal({
        type: 'terminal-attach', terminalId, attachmentId, attachmentEpoch: inventory.attachmentEpoch,
        clientId: 'synthetic-browser', afterSequence: 0, intent: 'restore',
      });
      await client.waitForEvent((message): message is Extract<TerminalStreamServerMessage, { type: 'terminal-attached' }> =>
        message.type === 'terminal-attached' && message.attachmentId === attachmentId, 'terminal attached');
      const chatId = fixture.newChatId();
      const held = fixture.fakeProviders.openAi.holdNext({ model: directAgents.openAi.provider.model });
      const accepted = await client.startDirectChat({ chatId, projectPath: project, content: 'Synthetic mixed service turn', agent: directAgents.openAi });
      await held.received;
      const eventsBefore = client.eventRecords().length;
      const started = performance.now();
      const elapsed: Record<string, number> = {};
      const record = <T>(name: string, promise: Promise<T>): Promise<T> => promise.then(result => {
        elapsed[name] = Math.round(performance.now() - started);
        return result;
      });
      const bodies = record('gitMs', client.post<ExecutionGitResults['getReviewDocumentFileBodies']>('/api/v1/git/review-documents/files', {
        nodeId, project, document, files: ['example.txt'], purpose: 'visible',
      }));
      const file = record('filesMs', client.get<ReadTextResponse>(`/api/v1/files/text?${new URLSearchParams({
        nodeId, projectPath: project, path: 'payload.txt',
      })}`));
      const output = record('terminalMs', client.waitForEvent((message): message is Extract<TerminalStreamServerMessage, { type: 'terminal-output' }> =>
        message.type === 'terminal-output' && message.attachmentId === attachmentId && message.data.includes('\u001b[32mshared-channel-ready'),
      'terminal output during Git transfer', { afterIndex: eventsBefore }));
      client.sendTerminal({ type: 'terminal-input', terminalId, attachmentId, data: "stty -echo; printf '\\033[32mshared-channel-ready\\033[0m\\n'\r" });
      expect(held.releaseText('Synthetic mixed service response')).toBe(true);
      const turn = record('chatMs', client.waitForTurnTerminal(chatId, accepted.turnId));
      const [review, loaded, , finished] = await Promise.all([bodies, file, output, turn]);
      expect(review.status).toBe('ready');
      if (review.status !== 'ready') throw new Error('Expected review bodies');
      expect(review.files['example.txt'].patch).toContain('+synthetic change 7999 ');
      expect(Buffer.byteLength(review.files['example.txt'].patch!)).toBeGreaterThan(256 * 1024);
      expect(loaded.content === content).toBe(true);
      expect(finished.type).toBe('agent-run-finished');
      const { nodes } = await client.get<{ nodes: ExecutionNodeSnapshot[] }>('/api/v1/execution-nodes');
      expect(nodes.find(node => node.id === nodeId)).toMatchObject({ availability: 'ready', instanceId: snapshot.instanceId });
      expect(client.eventRecords().slice(eventsBefore).filter(({ parsed }) =>
        parsed.type === 'execution-nodes-changed' && parsed.nodes.some(node => node.id === nodeId && node.availability !== 'ready'))).toEqual([]);
      console.info('Shared-channel completion timings', { executionBackend, ...elapsed });
      await client.delete('/api/v1/terminals', { terminalId, requestId: 'synthetic-shared-channel-close' });
    }, { executionBackend, projectRoots: 'separate', serverEnvironment: { GARCON_TERMINAL_SHELL: '/bin/sh' } });
  }, 60_000);
}
