import { expect, test } from 'bun:test';
import { expect as browserExpect } from 'playwright/test';
import type { ChatPreambleSelectionTargetResponse } from '../../../common/chat-preamble-selection-contracts.js';
import type { StartChatCommandResponse } from '../../../common/chat-command-contracts.js';
import type { PreamblesMutationResponse, PreamblesSnapshot } from '../../../common/preambles.js';
import { userContents } from '../../support/chat-assertions.js';
import { withChromiumFixture } from '../../support/chromium-fixture.js';

for (const executionBackend of ['in-process', 'remote-controller-dials', 'remote-executor-dials'] as const) {
  test(`scheduled existing-chat copies keep configuration but not history (${executionBackend})`, async () => {
    await withChromiumFixture(`scheduled-existing-chat-${executionBackend}`, async ({ page, integration }, phase) => {
      const { client } = integration;
      const agent = integration.directAgents.openAi;
      const catalog = await client.get<PreamblesSnapshot>('/api/v1/preambles');
      const created = await client.post<PreamblesMutationResponse>('/api/v1/preambles', {
        expectedRevision: catalog.revision,
        preamble: { enabled: true, title: 'Copy default', content: 'SYNTHETIC_COPY_DEFAULT', scope: { type: 'global' } },
      });
      const preamble = created.snapshot.preambles.find(entry => entry.title === 'Copy default');
      if (!preamble) throw new Error('Default preamble was not created');
      const sourceId = integration.newChatId();
      const started = await client.startChat({
        ...client.directStartRequest({ chatId: sourceId, agent, projectPath: integration.executionDirs.project,
          content: 'Synthetic source history, not part of the copied chat.', orderedPreambleIds: [] }),
        // CLI starts keep the source configuration out of New Chat defaults.
        origin: 'cli',
        tags: ['source-tag'],
      });
      expect((await client.waitForTurnTerminal(sourceId, started.turnId)).type).toBe('agent-run-finished');
      await client.updateSessionName(sourceId, 'Synthetic source title');
      const saved = await client.createScheduledPrompt({
        expectedRevision: (await client.getScheduledPrompts()).revision,
        scheduledPrompt: {
          name: 'Copy existing chat', prompt: 'Review {{chat_id}}',
          schedule: { type: 'once', runAtUtc: '2099-01-02T09:00:00.000Z' },
          target: { type: 'existing-chat', chatId: sourceId, busyBehavior: 'queue' },
        },
      });
      const sourceMessages = await client.getMessages(sourceId);

      phase('preparing an existing-chat copy without execution');
      await page.goto(integration.garcon.baseUrl);
      await page.getByRole('button', { name: 'More actions', exact: true }).click();
      await page.getByRole('menuitem', { name: 'Scheduled prompts', exact: true }).click();
      const list = page.getByRole('dialog', { name: 'Scheduled Prompts', exact: true });
      await list.getByRole('button', { name: 'Prompt actions' }).click();
      const rendering = page.waitForResponse(response => new URL(response.url()).pathname === '/api/v1/scheduled-prompts/render');
      await page.getByRole('menuitem', { name: 'Open in new chat', exact: true }).click();
      const rendered = await (await rendering).json();
      expect(rendered.chatId).not.toBe(sourceId);
      expect(rendered.expandedText).toBe(`Review ${rendered.chatId}`);
      const prompt = page.getByPlaceholder('How can I help you today?');
      const dialog = page.getByRole('dialog').filter({ has: prompt });
      await browserExpect(prompt).toHaveValue(rendered.expandedText);
      await browserExpect(dialog.getByRole('textbox', { name: 'Project Path', exact: true })).toHaveValue(integration.executionDirs.project);
      await browserExpect(dialog.getByRole('button', { name: 'Start session', exact: true })).toBeEnabled();
      expect((await client.listChats()).sessions.map(chat => chat.id)).toEqual([sourceId]);
      expect(await client.getMessages(sourceId)).toEqual(sourceMessages);
      expect(await client.getScheduledPrompts()).toEqual(saved.snapshot);

      phase('starting the edited copy with default preambles and no source history');
      const edited = `Edited ${rendered.expandedText}`;
      await prompt.fill(edited);
      const starting = page.waitForResponse(response => new URL(response.url()).pathname === '/api/v1/chats/start');
      await dialog.getByRole('button', { name: 'Start session', exact: true }).click();
      const response = await starting;
      expect(response.ok()).toBe(true);
      expect(response.request().postDataJSON()).toMatchObject({
        chatId: rendered.chatId, executorId: client.executorId, projectPath: integration.executionDirs.project,
        agentId: agent.agentId, model: agent.provider.model, apiProviderId: agent.provider.providerId,
        modelEndpointId: agent.provider.endpointId, modelProtocol: agent.provider.protocol,
        permissionMode: 'default', thinkingMode: 'none', agentSettings: agent.agentSettings,
        tags: ['source-tag'], command: edited,
      });
      expect(response.request().postDataJSON()).not.toHaveProperty('orderedPreambleIds');
      const accepted: StartChatCommandResponse = await response.json();
      expect((await client.waitForTurnTerminal(rendered.chatId, accepted.turnId)).type).toBe('agent-run-finished');
      expect(userContents((await client.getMessages(rendered.chatId)).messages)).toEqual([edited]);
      const selection = await client.get<ChatPreambleSelectionTargetResponse>(`/api/v1/chats/preambles?chatId=${rendered.chatId}`);
      expect(selection.selection.orderedPreambleIds).toEqual([preamble.id]);
      const sourceSelection = await client.get<ChatPreambleSelectionTargetResponse>(`/api/v1/chats/preambles?chatId=${sourceId}`);
      expect(sourceSelection.selection.orderedPreambleIds).toEqual([]);
      expect(await client.getMessages(sourceId)).toEqual(sourceMessages);
      expect(await client.getScheduledPrompts()).toEqual(saved.snapshot);
      const chats = (await client.listChats()).sessions;
      expect(chats.map(chat => chat.id).sort()).toEqual([sourceId, rendered.chatId].sort());
      expect(chats.find(chat => chat.id === rendered.chatId)?.title).not.toBe('Synthetic source title');
    }, undefined, { executionBackend, projectRoots: 'separate' });
  }, 120_000);
}
