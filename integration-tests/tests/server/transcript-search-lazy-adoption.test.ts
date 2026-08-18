import { describe, expect, test } from 'bun:test';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { withIntegrationFixture } from '../../support/integration-fixture.js';

describe('lazy transcript adoption search indexing', () => {
  test('[TLV5-L01.02-SEARCH-LAZY-ADOPTION-SERVER-01] indexes a lazy adoption without a later commit', async () => {
    await withIntegrationFixture('transcript-search-lazy-adoption', async (fixture) => {
      const chatId = fixture.newChatId();
      const marker = 'syntheticlazyadoptionmarker';
      const started = await fixture.client.startDirectChat({
        chatId,
        content: 'synthetic setup message',
        projectPath: fixture.dirs.project,
        agent: fixture.directAgents.openAi,
      });
      expect((await fixture.client.waitForTurnTerminal(chatId, started.turnId)).type).toBe(
        'agent-run-finished',
      );
      const beforeNativeRequests = fixture.fakeProviders.openAi.requests().length;

      await fixture.restartGarcon({
        beforeStart: async () => {
          const registry = JSON.parse(
            await readFile(join(fixture.dirs.workspace, 'chats.json'), 'utf8'),
          ) as { sessions?: Record<string, Record<string, unknown>> };
          const chat = registry.sessions?.[chatId];
          const agentSessionId = chat?.agentSessionId;
          const modelEndpointId = chat?.modelEndpointId;
          if (typeof agentSessionId !== 'string' || typeof modelEndpointId !== 'string') {
            throw new Error('Synthetic Direct chat was not persisted before restart.');
          }
          const legacySourceDirectory = join(
            fixture.dirs.workspace,
            'agent-data',
            'direct-openai-compatible',
            'openai-compatible-sessions',
            modelEndpointId,
          );
          await mkdir(legacySourceDirectory, { recursive: true });
          const legacySourcePath = join(legacySourceDirectory, `${agentSessionId}.jsonl`);
          await writeFile(legacySourcePath, [
            { role: 'user', content: marker, timestamp: '2026-08-17T00:00:00.000Z' },
            { role: 'assistant', content: 'synthetic adopted response', timestamp: '2026-08-17T00:00:01.000Z' },
          ].map((entry) => JSON.stringify(entry)).join('\n') + '\n', 'utf8');
          const settingsPath = join(fixture.dirs.workspace, 'project-settings.json');
          const settings = JSON.parse(await readFile(settingsPath, 'utf8')) as Record<string, unknown>;
          const features = settings.features && typeof settings.features === 'object'
            ? settings.features as Record<string, unknown>
            : {};
          settings.features = {
            ...features,
            transcriptSearch: { enabled: true },
          };
          await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
          await rm(join(fixture.dirs.workspace, 'transcript-ledgers', chatId), {
            recursive: true,
            force: true,
          });
        },
      });

      const adopted = await fixture.client.getMessages(chatId);
      const result = await fixture.client.waitForChatSearch(
        { query: marker, chatIds: [chatId] },
        (response) => response.index.pendingChatCount === 0
          && response.index.indexedChatCount === 1
          && response.results.some((entry) => entry.chatId === chatId),
      );

      const adoptedRows = adopted.messages.filter((entry) => (
        entry.message.type === 'user-message' && entry.message.content === marker
      ));
      expect(adoptedRows).toHaveLength(1);
      const match = result.results.find((entry) => entry.chatId === chatId);
      expect(result.results.map((entry) => entry.chatId)).toEqual([chatId]);
      expect(match?.transcriptViewId).toBe(adopted.transcriptViewId);
      expect(match?.snippets).toContainEqual(expect.objectContaining({
        ordinal: adoptedRows[0]?.ordinal,
        role: 'user',
        text: marker,
      }));
      expect(fixture.fakeProviders.openAi.requests()).toHaveLength(beforeNativeRequests);
    });
  });
});
