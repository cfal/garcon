import { expect, test } from 'bun:test';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { PreamblesSnapshot, PreamblesMutationResponse } from '../../../common/preambles.js';
import type { PreambleSelectionPreviewResponse } from '../../../common/chat-preamble-selection-contracts.js';
import { parseTerminalStreamServerMessage } from '../../../common/terminal.js';
import { assertRealWithinBase } from '../../../server/lib/path-boundary.js';
import { userContents } from '../../support/chat-assertions.js';
import { withIntegrationFixture } from '../../support/integration-fixture.js';

async function terminalResponse(baseUrl: string) {
  const received = Promise.withResolvers<unknown>();
  const closed = Promise.withResolvers<void>();
  const socket = new WebSocket(`${baseUrl.replace(/^http/, 'ws')}/ws`);
  socket.addEventListener('open', () => socket.send(JSON.stringify({
    type: 'terminal-attach', terminalId: 'synthetic-terminal', clientId: 'synthetic-client',
    afterSequence: 0, intent: 'restore',
  })));
  socket.addEventListener('message', (event) => {
    const message = parseTerminalStreamServerMessage(JSON.parse(String(event.data)));
    if (message?.type === 'terminal-error') received.resolve(message);
  });
  socket.addEventListener('error', () => received.reject(new Error('Terminal test socket failed')));
  socket.addEventListener('close', () => closed.resolve());
  try { return await received.promise; }
  finally { socket.close(); await closed.promise; }
}

for (const backend of ['remote-controller-dials', 'remote-node-dials'] as const) {
  test(`project inputs stay on the worker with disjoint roots (${backend})`, async () => {
    await withIntegrationFixture(`remote-projects-${backend}`, async (fixture) => {
      const projectPath = fixture.executionDirs.project;
      const client = fixture.client;
      await expect(assertRealWithinBase(fixture.dirs.project, projectPath)).rejects.toThrow();
      expect(await client.get('/api/v1/app/settings')).toMatchObject({ projectBasePath: projectPath });
      expect(await client.get(`/api/v1/chats/validate-start?path=${encodeURIComponent(projectPath)}`))
        .toMatchObject({ valid: true });
      expect(await client.get(`/api/v1/projects/resolve?projectPath=${encodeURIComponent(fixture.dirs.project)}`))
        .toMatchObject({ resolution: { kind: 'unavailable', reason: 'outside-base' } });

      await writeFile(join(projectPath, 'input.txt'), 'synthetic worker file');
      await writeFile(join(projectPath, 'private.txt'), 'must not expand private preamble mentions');
      await writeFile(join(fixture.dirs.project, 'input.txt'), 'must not read controller file');
      const catalog = await client.get<PreamblesSnapshot>('/api/v1/preambles');
      const created = await client.post<PreamblesMutationResponse>('/api/v1/preambles', {
        expectedRevision: catalog.revision,
        preamble: {
          enabled: true, title: 'Worker scope', content: 'Private @private.txt',
          scope: { type: 'project-paths', rules: [{ projectPath, includeNested: true }] },
        },
      });
      const preamble = created.snapshot.preambles.find((entry) => entry.title === 'Worker scope')!;
      const preview = await client.post<PreambleSelectionPreviewResponse>('/api/v1/preambles/selection-preview', {
        projectPath, agentId: fixture.directAgents.openAi.agentId, tags: [],
      });
      expect(preview.canonicalProjectPath).toBe(projectPath);
      expect(preview.orderedPreambleIds).toContain(preamble.id);

      const chatId = fixture.newChatId();
      const held = fixture.fakeProviders.openAi.holdNext({ model: fixture.directAgents.openAi.provider.model });
      const command = 'Read @input.txt';
      const started = await client.startDirectChat({ chatId, content: command, projectPath, agent: fixture.directAgents.openAi });
      const nativeRequest = await held.received;
      expect(nativeRequest.lastUserText).toContain('Private @private.txt');
      expect(nativeRequest.lastUserText).toContain('synthetic worker file');
      expect(nativeRequest.lastUserText).not.toContain('must not expand');
      expect(nativeRequest.lastUserText).not.toContain('must not read controller');
      expect(userContents((await client.getMessages(chatId)).messages)).toEqual([command]);
      expect(held.releaseText('synthetic answer')).toBe(true);
      await client.waitForTurnTerminal(chatId, started.turnId);

      for (const route of ['files/browse', 'git/status', 'gh/pull-requests', 'terminals']) {
        await expect(client.get(`/api/v1/${route}?projectPath=${encodeURIComponent(projectPath)}`))
          .rejects.toMatchObject({ status: 501, body: { errorCode: 'OPERATION_UNSUPPORTED' } });
      }
      expect(await terminalResponse(fixture.garcon.baseUrl)).toMatchObject({
        type: 'terminal-error', code: 'terminal-unsupported',
      });
      await expect(client.post('/api/v1/tickets/project-default', { directory: fixture.dirs.project }))
        .rejects.toMatchObject({ body: { errorCode: 'TICKET_PROJECT_UNAVAILABLE' } });

      await fixture.crashAndRestartGarcon({ preserveExecutionWorker: true });
      expect(await fixture.client.get<PreamblesSnapshot>('/api/v1/preambles')).toEqual(created.snapshot);
      expect(userContents((await fixture.client.getMessages(chatId)).messages)).toEqual([command]);
      const target = fixture.directAgents.openAi;
      await fixture.client.updateSettings({ ui: { promptRefinement: {
        agentId: target.agentId, model: target.provider.model,
        apiProviderId: target.provider.providerId, modelEndpointId: target.provider.endpointId,
        modelProtocol: target.provider.protocol, thinkingMode: 'none',
      } } });
      const query = fixture.fakeProviders.openAi.holdNext({ model: target.provider.model });
      const refinement = fixture.client.refinePrompt({ draft: 'Synthetic draft', target: 'prompt' });
      await query.received;
      expect(query.releaseText('Synthetic refinement')).toBe(true);
      expect(await refinement).toEqual({ success: true, refinedPrompt: 'Synthetic refinement' });
    }, { executionBackend: backend, projectRoots: 'separate' });
  }, 40_000);
}
