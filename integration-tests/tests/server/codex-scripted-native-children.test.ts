import { expect, test } from 'bun:test';
import { assistantContents, userContents } from '../../support/chat-assertions.js';
import { codexAssistantMessage, codexCollaborationCall, codexFinalAnswerMessage } from '../../support/fake-codex-model.js';
import { withIntegrationFixture } from '../../support/integration-fixture.js';
import { liveCodexStartRequest } from '../../support/live-codex.js';
import { startScriptedCodexTestEnvironment } from '../../support/scripted-codex.js';
import { rejectionOf } from '../../support/promise-assertions.js';
import { GarconWsRequestError } from '../../support/garcon-client.js';
import { withTimeout } from '../../support/deferred.js';

for (const multiAgentVersion of ['v1', 'v2'] as const) test(`[TLV5-OBSERVE.04-CODEX-SCRIPTED-01] captures Codex ${multiAgentVersion} child output after the parent terminal without granting independent execution`, async () => {
  const environment = await startScriptedCodexTestEnvironment();
  environment.model.scriptTurn([{ ...codexCollaborationCall('spawn_worker', 'spawn_agent', {
    message: 'Synthetic native child kickoff', ...(multiAgentVersion === 'v2' ? { task_name: 'worker', fork_turns: 'none' } : {}),
  }), namespace: multiAgentVersion === 'v1' ? 'multi_agent_v1' : 'collaboration' }]);
  const held = environment.model.scriptHeldTurnMatching('child request', request =>
    JSON.stringify(request.body).includes('Synthetic native child kickoff')
      && !request.functionCallOutputs.some(output => output.callId === 'spawn_worker'),
  [codexFinalAnswerMessage('Synthetic native child answer')]);
  environment.model.scriptTurnMatching('parent continuation', request =>
    request.functionCallOutputs.some(output => output.callId === 'spawn_worker'),
  [codexAssistantMessage('Synthetic native parent answer')]);
  try {
    await withIntegrationFixture('codex-native-child', async fixture => {
      const rootId = fixture.newChatId();
      const cursor = fixture.client.markEvents();
      const started = await fixture.client.startChat(liveCodexStartRequest({
        chatId: rootId, projectPath: fixture.dirs.project, command: 'Synthetic spawn request', permissionMode: 'bypassPermissions',
      }));
      await withTimeout(held.requested, 30_000, () => 'Native child did not request the scripted model');
      expect((await fixture.client.waitForTurnTerminal(rootId, started.turnId, { afterIndex: cursor, timeoutMs: 30_000 })).type)
        .toBe('agent-run-finished');
      const children = (await fixture.client.listChats()).sessions.filter(chat => chat.parentChatId === rootId);
      expect(children).toHaveLength(1);
      const child = children[0]!;
      expect(child.observation).toMatchObject({ kind: 'native-child', captureStatus: 'attached' });
      expect(await rejectionOf(fixture.client.reloadChat(child.id))).toMatchObject({ message: expect.stringContaining('CHAT_RUNNING') });
      expect(await rejectionOf(fixture.client.enqueueNew(child.id, 'Forbidden input'))).toMatchObject({ message: expect.stringContaining('CHAT_READ_ONLY') });
      const before = await fixture.client.getMessages(child.id);
      await fixture.client.subscribe(child.id, before.transcriptViewId, 0);
      held.release();
      await fixture.client.waitForEvent((event): event is Extract<typeof event, { type: 'chat-messages' }> => event.type === 'chat-messages' && event.chatId === child.id
        && assistantContents(event.messages).includes('Synthetic native child answer'),
      'child answer after parent terminal', { afterIndex: cursor, timeoutMs: 30_000 });
      const captured = await fixture.client.getMessages(child.id);
      expect(assistantContents(captured.messages)).toContain('Synthetic native child answer');
      if (multiAgentVersion === 'v1') expect(userContents(captured.messages).join('\n')).toContain('Synthetic native child kickoff');
      else expect(userContents(captured.messages)).toEqual([]);
      expect(assistantContents((await fixture.client.getMessages(rootId)).messages)).toEqual(['Synthetic native parent answer']);
      await fixture.client.waitForEvent((event): event is Extract<typeof event, { type: 'chat-messages' }> =>
        event.type === 'chat-messages' && event.chatId === child.id && event.messages.some(({ message }) =>
          message.type === 'transcript-notice' && message.content === 'Native subagent completed.'),
      'native child terminal', { afterIndex: cursor, timeoutMs: 30_000 });
      // The parent's final activity notification can follow the child's terminal.
      const reloaded = await (async () => {
        const deadline = Date.now() + 10_000;
        while (true) {
          try { return await fixture.client.reloadChat(child.id); }
          catch (error) {
            if (!(error instanceof GarconWsRequestError) || error.response.code !== 'CHAT_RUNNING'
              || Date.now() >= deadline) throw error;
            expect((await fixture.client.getMessages(child.id)).transcriptViewId).toBe(captured.transcriptViewId);
            await Bun.sleep(50);
          }
        }
      })();
      expect(reloaded.transcriptViewId).not.toBe(captured.transcriptViewId);
      const retained = await fixture.client.getMessages(child.id);
      expect(assistantContents(retained.messages)).toContain('Synthetic native child answer');
      if (multiAgentVersion === 'v1') expect(userContents(retained.messages).join('\n')).toContain('Synthetic native child kickoff');
      else expect(userContents(retained.messages)).toEqual([]);
      await fixture.restartGarcon();
      expect(assistantContents((await fixture.client.getMessages(child.id)).messages)).toContain('Synthetic native child answer');
      expect((await fixture.client.getChatSnapshot(child.id)).chat.observation?.captureStatus).toBe('detached');
      await fixture.client.deleteChat(child.id);
      expect((await fixture.client.listChats()).sessions.filter(chat => chat.parentChatId === rootId)).toEqual([]);
      environment.model.assertSettled();
    }, { serverEnvironment: environment.serverEnvironment,
      prepareWorkspace: directories => environment.prepareWorkspace(directories, { multiAgentVersion }) });
  } finally { held.release(); await environment.dispose(); }
}, 120_000);
