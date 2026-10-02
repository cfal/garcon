import { expect, test } from 'bun:test';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { TranscriptLedgerStore } from '../../../server/controller/ledger/store.js';
import { withIntegrationFixture } from '../../support/integration-fixture.js';
import { rejectionOf } from '../../support/promise-assertions.js';

for (const backend of ['in-process', 'remote-controller-dials', 'remote-executor-dials'] as const) {
  test(`startup and ledger reads do not require native history (${backend})`, async () => {
    await withIntegrationFixture(`lazy-native-${backend}`, async (fixture) => {
      await fixture.client.updateSettings({ features: { transcriptSearch: { enabled: false } } });
      const missingChat = fixture.newChatId();
      const healthyChat = fixture.newChatId();
      const legacyChat = fixture.newChatId();
      const claude = (await fixture.client.listAgentCatalog()).agents.find((agent) => agent.id === 'claude');
      if (!claude) throw new Error('Claude descriptor missing');
      for (const [chatId, content] of [[missingChat, 'Synthetic missing native'], [healthyChat, 'Synthetic healthy native']] as const) {
        const started = await fixture.client.startDirectChat({
          chatId, content, projectPath: fixture.dirs.project, agent: fixture.directAgents.openAi,
        });
        expect(await fixture.client.waitForTurnTerminal(chatId, started.turnId))
          .toMatchObject({ type: 'agent-run-finished' });
      }
      const missingBefore = await fixture.client.getMessages(missingChat);
      const healthyBefore = await fixture.client.getMessages(healthyChat);
      const registryPath = join(fixture.dirs.workspace, 'chats.json');
      await fixture.restartGarcon({ beforeStart: async () => {
        await rm(await fixture.directOpenAiNativePath(missingChat));
        await rm(join(fixture.dirs.workspace, 'chat-metadata.json'), { force: true });
        const registry = JSON.parse(await readFile(registryPath, 'utf8'));
        registry.sessions[legacyChat] = {
          ...registry.sessions[missingChat],
          agentId: 'claude', model: claude.defaultModel,
          agentSettingsById: { claude: claude.defaultSettings },
          agentSessionId: '00000000-0000-4000-8000-000000000001',
          nativeSession: null, nativeSeedReceipt: null,
          apiProviderId: null, modelEndpointId: null, modelProtocol: null,
        };
        registry.sessions[healthyChat].agentSessionId = 'stale-session-cache';
        registry.sessions[healthyChat].nativeSession = null;
        registry.sessions[healthyChat].nativeSeedReceipt = null;
        await writeFile(registryPath, JSON.stringify(registry));
      } });

      const startupLogs = fixture.garcon.logs.join('\n');
      expect(startupLogs).not.toMatch(/native session reconciliation|unresolved native session|searching projects|adoption source failed/i);
      const ledgers = new TranscriptLedgerStore(join(fixture.dirs.workspace, 'transcript-ledgers'));
      try {
        expect(ledgers.existingCurrentView(legacyChat)).toBeNull();
      } finally {
        ledgers.close();
      }
      const listed = (await fixture.client.listChats()).sessions;
      expect(listed.map((chat) => chat.id)).toEqual(expect.arrayContaining([missingChat, healthyChat, legacyChat]));

      // Uses a retained view ID so the command, not a preceding history request, repairs the cache.
      const resumed = await fixture.client.runChat({
        ...fixture.client.directRunRequest({
          chatId: healthyChat, content: 'Synthetic resumed without activation', agent: fixture.directAgents.openAi,
        }),
        transcriptViewId: healthyBefore.transcriptViewId,
      });
      expect(await fixture.client.waitForTurnTerminal(healthyChat, resumed.turnId))
        .toMatchObject({ type: 'agent-run-finished' });
      expect(fixture.fakeProviders.openAi.requests().at(-1)?.body.messages.map((message) => message.content))
        .toEqual(['Synthetic healthy native', 'echo:Synthetic healthy native', 'Synthetic resumed without activation']);

      if (backend !== 'in-process') {
        await fixture.client.patch(`/api/v1/executors/${fixture.client.executorId}`, { enabled: false });
      }
      const readable = await fixture.client.getMessages(missingChat, { purpose: 'activation' });
      expect(readable).toMatchObject({
        transcriptViewId: missingBefore.transcriptViewId,
        lastOrdinal: missingBefore.lastOrdinal,
        messages: missingBefore.messages,
      });
      if (backend !== 'in-process') {
        await fixture.client.patch(`/api/v1/executors/${fixture.client.executorId}`, { enabled: true });
        await fixture.crashAndRestartExecutorWorker();
      }
      const requestCount = fixture.fakeProviders.openAi.requests().length;
      expect(await rejectionOf(fixture.client.reloadChat(missingChat))).toMatchObject({
        response: { code: 'HISTORY_LOAD_FAILED' },
      });
      const afterReload = await fixture.client.getMessages(missingChat);
      expect(afterReload.transcriptViewId).toBe(missingBefore.transcriptViewId);
      expect(afterReload.messages).toEqual(missingBefore.messages);
      const failed = await fixture.client.runChat({
        ...fixture.client.directRunRequest({
          chatId: missingChat, content: 'Synthetic missing-state resume', agent: fixture.directAgents.openAi,
        }),
        transcriptViewId: missingBefore.transcriptViewId,
      });
      expect(await fixture.client.waitForTurnTerminal(missingChat, failed.turnId))
        .toMatchObject({ type: 'agent-run-failed', error: expect.stringContaining('Direct history is unavailable') });
      expect(fixture.fakeProviders.openAi.requests()).toHaveLength(requestCount);
      expect((await fixture.client.getMessages(missingChat)).transcriptViewId).toBe(missingBefore.transcriptViewId);
    }, { executionBackend: backend });
  }, 60_000);
}
