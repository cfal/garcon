import { expect, test } from 'bun:test';
import { assistantContents, messagesOfType, userContents } from '../../support/chat-assertions.js';
import { claudeText, claudeToolUse } from '../../support/fake-claude-model.js';
import { withIntegrationFixture } from '../../support/integration-fixture.js';
import { liveClaudeStartRequest } from '../../support/live-claude.js';
import { startScriptedClaudeTestEnvironment } from '../../support/scripted-claude.js';
import { runCli } from '../../support/cli-fixture.js';
import { rejectionOf } from '../../support/promise-assertions.js';

test('[TLV5-OBSERVE.03-CLAUDE-SCRIPTED-01] captures a newly streamed native Claude child as a durable read-only chat and explicitly reloads it', async () => {
  const environment = await startScriptedClaudeTestEnvironment();
  environment.model.scriptTurn([claudeToolUse('toolu_child_spawn', 'Agent', {
    subagent_type: 'general-purpose', description: 'Synthetic child', prompt: 'Synthetic child kickoff', run_in_background: false,
  })]);
  for (let index = 0; index < 3; index++) environment.model.scriptTurn(request => {
    if (request.userTexts.some(text => text.includes('Synthetic child kickoff'))) {
      return request.toolResults.some(result => result.toolUseId === 'toolu_child_bash')
        ? [claudeText('Synthetic child answer')]
        : [claudeToolUse('toolu_child_bash', 'Bash', { command: 'printf synthetic-child-output' })];
    }
    return [claudeText('Synthetic parent answer')];
  });
  try {
    await withIntegrationFixture('claude-native-child', async fixture => {
      const rootId = fixture.newChatId();
      const cursor = fixture.client.markEvents();
      const started = await fixture.client.startChat(liveClaudeStartRequest({
        chatId: rootId, projectPath: fixture.dirs.project, command: 'Synthetic root request', permissionMode: 'bypassPermissions',
      }));
      const terminal = await fixture.client.waitForTurnTerminal(rootId, started.turnId, { afterIndex: cursor, timeoutMs: 45_000 });
      expect(terminal.type).toBe('agent-run-finished');
      const children = (await fixture.client.listChats()).sessions.filter(chat => chat.parentChatId === rootId);
      expect(children).toHaveLength(1);
      const child = children[0]!;
      expect(child.observation).toMatchObject({ kind: 'native-child', captureStatus: 'attached' });
      const captured = await fixture.client.getMessages(child.id);
      expect(assistantContents(captured.messages)).toContain('Synthetic child answer');
      expect(userContents(captured.messages)).toEqual(['Synthetic child kickoff']);
      expect(messagesOfType(captured.messages, 'bash-tool-use')).toHaveLength(1);
      const parent = await fixture.client.getMessages(rootId);
      expect(assistantContents(parent.messages)).toEqual(['Synthetic parent answer']);
      expect(messagesOfType(parent.messages, 'bash-tool-use')).toEqual([]);
      expect(await rejectionOf(fixture.client.enqueueNew(child.id, 'Forbidden child input'))).toMatchObject({ message: expect.stringContaining('CHAT_READ_ONLY') });
      if (fixture.client.executorId !== 'local') {
        await fixture.client.patch(`/api/v1/executors/${fixture.client.executorId}`, { allowControllerCli: true });
      }
      const denied = await runCli(fixture, ['add-row', child.id, '--type', 'notice', 'Forbidden observed row']);
      expect(denied.exitCode).not.toBe(0);
      expect(denied.stderr).toContain('CHAT_READ_ONLY');
      const beforeSelection = await fixture.client.getChatSnapshot(child.id);
      expect(await rejectionOf(fixture.client.put('/api/v1/chats/preambles', {
        chatId: child.id, clientRequestId: 'readonly-preambles', clientMessageId: 'readonly-preambles',
        transcriptViewId: captured.transcriptViewId, expectedRevision: 0, orderedPreambleIds: [],
      }))).toMatchObject({ message: expect.stringContaining('CHAT_READ_ONLY') });
      expect((await fixture.client.getMessages(child.id)).lastOrdinal).toBe(captured.lastOrdinal);
      expect((await fixture.client.getChatSnapshot(child.id)).chat).toEqual(beforeSelection.chat);
      const reloaded = await fixture.client.reloadChat(child.id);
      expect(reloaded.transcriptViewId).not.toBe(captured.transcriptViewId);
      expect(assistantContents((await fixture.client.getMessages(child.id)).messages)).toContain('Synthetic child answer');
      expect(userContents((await fixture.client.getMessages(child.id)).messages).join('\n')).toContain('Synthetic child kickoff');
      expect((await fixture.client.getChatSnapshot(child.id)).chat.observation?.captureStatus).toBe('detached');
      await fixture.restartGarcon();
      expect(assistantContents((await fixture.client.getMessages(child.id)).messages)).toContain('Synthetic child answer');
      await fixture.client.deleteChat(rootId);
      expect((await fixture.client.getChatSnapshot(child.id)).chat.observation?.kind).toBe('native-child');
      await fixture.client.deleteChat(child.id);
      expect((await fixture.client.listChats()).sessions).toEqual([]);
      environment.model.assertSettled();
    }, { serverEnvironment: environment.serverEnvironment,
      extraDiagnostics: () => ({ scriptedRequests: environment.model.requests().map(request => ({
        userTexts: request.userTexts, toolResults: request.toolResults,
      })) }) });
  } finally { environment.dispose(); }
}, 120_000);
