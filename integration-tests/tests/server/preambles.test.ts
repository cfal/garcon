import { describe, expect, test } from 'bun:test';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  Preamble,
  PreambleDefinitionInput,
  PreamblesMutationResponse,
  PreamblesSnapshot,
} from '../../../common/preambles.js';
import { messagesOfType, userContents } from '../../support/chat-assertions.js';
import type { ChatMessagesPage } from '../../support/garcon-client.js';
import { GarconApiError } from '../../support/garcon-client.js';
import {
  type IntegrationFixture,
  withIntegrationFixture,
} from '../../support/integration-fixture.js';

async function createPreamble(
  fixture: IntegrationFixture,
  revision: number,
  preamble: PreambleDefinitionInput,
): Promise<PreamblesMutationResponse> {
  return fixture.client.post('/api/v1/preambles', {
    expectedRevision: revision,
    preamble,
  });
}

function applicationTitles(snapshot: ChatMessagesPage): string[][] {
  return messagesOfType(snapshot.messages, 'transcript-notice')
    .filter((message) => message.detail?.type === 'preamble-application')
    .map((message) => message.detail?.type === 'preamble-application'
      ? message.detail.preambles.map((preamble) => preamble.title)
      : []);
}

describe('preambles', () => {
  test('applies ordered current preambles once at new-chat and fork boundaries', async () => {
    await withIntegrationFixture('preambles', async (fixture) => {
      const nestedProject = join(fixture.dirs.project, 'nested');
      await mkdir(nestedProject, { recursive: true });

      const definitions: PreambleDefinitionInput[] = [
        {
          enabled: true,
          title: 'Global opening',
          content: 'SYNTHETIC_GLOBAL_OPENING_BODY',
          scope: { type: 'global' },
        },
        {
          enabled: true,
          title: 'Nested project',
          content: 'SYNTHETIC_NESTED_PROJECT_BODY',
          scope: {
            type: 'project-paths',
            rules: [{ projectPath: fixture.dirs.project, includeNested: true }],
          },
        },
        {
          enabled: true,
          title: 'Global closing',
          content: 'SYNTHETIC_GLOBAL_CLOSING_BODY',
          scope: { type: 'global' },
        },
        {
          enabled: false,
          title: 'Disabled global',
          content: 'SYNTHETIC_DISABLED_GLOBAL_BODY',
          scope: { type: 'global' },
        },
      ];

      let catalog: PreamblesSnapshot = { revision: 0, preambles: [] };
      for (const definition of definitions) {
        catalog = (await createPreamble(fixture, catalog.revision, definition)).snapshot;
      }
      expect(catalog.preambles.map((preamble) => preamble.title)).toEqual([
        'Global opening',
        'Nested project',
        'Global closing',
        'Disabled global',
      ]);

      const sourceChatId = fixture.newChatId();
      const firstHeld = fixture.fakeProviders.openAi.holdNext({
        model: fixture.directAgents.openAi.provider.model,
      });
      const first = await fixture.client.startDirectChat({
        chatId: sourceChatId,
        content: 'first visible prompt',
        projectPath: nestedProject,
        agent: fixture.directAgents.openAi,
      });
      const firstProviderRequest = await firstHeld.received;
      expect(firstProviderRequest.lastUserText).toMatch(
        /^<garcon-preambles version="1" application="[a-f0-9]{64}">\nSYNTHETIC_GLOBAL_OPENING_BODY\n\nSYNTHETIC_NESTED_PROJECT_BODY\n\nSYNTHETIC_GLOBAL_CLOSING_BODY\n<\/garcon-preambles>\n\nfirst visible prompt$/u,
      );
      expect(firstProviderRequest.lastUserText).not.toContain('SYNTHETIC_DISABLED_GLOBAL_BODY');
      expect(firstHeld.releaseText('first synthetic response')).toBeTrue();
      await fixture.client.waitForTurnTerminal(sourceChatId, first.turnId);

      const firstHistory = await fixture.client.getMessages(sourceChatId);
      expect(firstHistory.messages.map((entry) => entry.message.type)).toEqual([
        'transcript-notice',
        'user-message',
        'assistant-message',
      ]);
      expect(applicationTitles(firstHistory)).toEqual([[
        'Global opening',
        'Nested project',
        'Global closing',
      ]]);
      expect(userContents(firstHistory.messages)).toEqual(['first visible prompt']);
      expect(JSON.stringify(firstHistory)).not.toContain('SYNTHETIC_GLOBAL_OPENING_BODY');
      expect(JSON.stringify(firstHistory)).not.toContain('SYNTHETIC_NESTED_PROJECT_BODY');
      expect(JSON.stringify(firstHistory)).not.toContain('SYNTHETIC_GLOBAL_CLOSING_BODY');

      const ordinaryHeld = fixture.fakeProviders.openAi.holdNext({
        lastUserText: 'ordinary visible prompt',
      });
      const ordinary = await fixture.client.runDirectChat({
        chatId: sourceChatId,
        content: 'ordinary visible prompt',
        agent: fixture.directAgents.openAi,
      });
      await ordinaryHeld.received;
      expect(ordinaryHeld.releaseText('ordinary synthetic response')).toBeTrue();
      await fixture.client.waitForTurnTerminal(sourceChatId, ordinary.turnId);
      expect(applicationTitles(await fixture.client.getMessages(sourceChatId))).toHaveLength(1);

      const slashForkChatId = fixture.newChatId();
      await fixture.client.forkChat({ sourceChatId, chatId: slashForkChatId });
      let slashFailure: unknown;
      try {
        await fixture.client.runDirectChat({
          chatId: slashForkChatId,
          content: '/provider-command',
          agent: fixture.directAgents.openAi,
        });
      } catch (error) {
        slashFailure = error;
      }
      expect(slashFailure).toBeInstanceOf(GarconApiError);
      expect(slashFailure).toMatchObject({
        status: 422,
        body: {
          errorCode: 'PREAMBLE_SLASH_COMMAND_BLOCKED',
          error: 'Matching preambles haven\u2019t been sent yet. Start with a regular message before using provider slash commands.',
        },
      });
      expect(userContents((await fixture.client.getMessages(slashForkChatId)).messages)).not.toContain(
        '/provider-command',
      );

      const afterSlashHeld = fixture.fakeProviders.openAi.holdNext({
        model: fixture.directAgents.openAi.provider.model,
      });
      const afterSlash = await fixture.client.runDirectChat({
        chatId: slashForkChatId,
        content: 'regular message after blocked slash command',
        agent: fixture.directAgents.openAi,
      });
      const afterSlashRequest = await afterSlashHeld.received;
      expect(afterSlashRequest.lastUserText).toContain('SYNTHETIC_GLOBAL_OPENING_BODY');
      expect(afterSlashRequest.lastUserText).not.toContain('SYNTHETIC_DISABLED_GLOBAL_BODY');
      expect(afterSlashHeld.releaseText('after slash synthetic response')).toBeTrue();
      await fixture.client.waitForTurnTerminal(slashForkChatId, afterSlash.turnId);
      expect(applicationTitles(await fixture.client.getMessages(slashForkChatId))).toHaveLength(2);

      const opening = catalog.preambles[0] as Preamble;
      const updated = await fixture.client.put<PreamblesMutationResponse>('/api/v1/preambles', {
        expectedRevision: catalog.revision,
        id: opening.id,
        preamble: {
          enabled: true,
          title: 'Global opening current',
          content: 'SYNTHETIC_CURRENT_OPENING_BODY',
          scope: { type: 'global' },
        },
      });
      catalog = updated.snapshot;

      const targetChatId = fixture.newChatId();
      const forkHeld = fixture.fakeProviders.openAi.holdNext({
        model: fixture.directAgents.openAi.provider.model,
      });
      const fork = await fixture.client.forkRunChat({
        sourceChatId,
        chatId: targetChatId,
        command: 'fork visible prompt',
        clientRequestId: crypto.randomUUID(),
        clientMessageId: crypto.randomUUID(),
        permissionMode: 'default',
        thinkingMode: 'none',
        model: fixture.directAgents.openAi.provider.model,
        apiProviderId: fixture.directAgents.openAi.provider.providerId,
        modelEndpointId: fixture.directAgents.openAi.provider.endpointId,
        modelProtocol: fixture.directAgents.openAi.provider.protocol,
      });
      const forkProviderRequest = await forkHeld.received;
      expect(forkProviderRequest.lastUserText).toContain('SYNTHETIC_CURRENT_OPENING_BODY');
      expect(forkProviderRequest.lastUserText).toContain('SYNTHETIC_NESTED_PROJECT_BODY');
      expect(forkProviderRequest.lastUserText).toContain('SYNTHETIC_GLOBAL_CLOSING_BODY');
      expect(forkProviderRequest.lastUserText).not.toContain('SYNTHETIC_GLOBAL_OPENING_BODY');
      expect(forkProviderRequest.lastUserText).toEndWith('fork visible prompt');
      expect(forkHeld.releaseText('fork synthetic response')).toBeTrue();
      await fixture.client.waitForTurnTerminal(targetChatId, fork.turnId);

      const forkHistory = await fixture.client.getMessages(targetChatId);
      expect(applicationTitles(forkHistory)).toEqual([
        ['Global opening', 'Nested project', 'Global closing'],
        ['Global opening current', 'Nested project', 'Global closing'],
      ]);
      expect(JSON.stringify(forkHistory)).not.toContain('SYNTHETIC_CURRENT_OPENING_BODY');

      await fixture.restartGarcon();
      expect(applicationTitles(await fixture.client.getMessages(targetChatId))).toEqual([
        ['Global opening', 'Nested project', 'Global closing'],
        ['Global opening current', 'Nested project', 'Global closing'],
      ]);
    });
  }, 60_000);
});
