import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { messagesOfType } from '../../support/chat-assertions.js';
import {
  codexAssistantMessage,
  codexCollaborationCall,
  codexFinalAnswerMessage,
} from '../../support/fake-codex-model.js';
import { withIntegrationFixture } from '../../support/integration-fixture.js';
import { liveCodexStartRequest } from '../../support/live-codex.js';
import {
  startScriptedCodexTestEnvironment,
  type ScriptedCodexTestEnvironment,
} from '../../support/scripted-codex.js';

describe('scripted Codex late subagent lifecycle', () => {
  let environment: ScriptedCodexTestEnvironment | undefined;

  beforeAll(async () => {
    environment = await startScriptedCodexTestEnvironment();
  });

  afterAll(async () => {
    await environment?.dispose();
  });

  test('publishes completed child activity after the root terminal exactly once', async () => {
    if (!environment) throw new Error('Scripted Codex environment was not initialized.');
    const testEnvironment = environment;
    const childPrompt = `Complete child work ${crypto.randomUUID()}.`;
    const childReply = `SCRIPTED_CODEX_CHILD_${crypto.randomUUID().replaceAll('-', '')}`;
    const rootReply = `SCRIPTED_CODEX_ROOT_${crypto.randomUUID().replaceAll('-', '')}`;
    testEnvironment.model.scriptTurn([
      codexCollaborationCall('spawn_worker', 'spawn_agent', {
        message: childPrompt,
        task_name: 'worker',
        fork_turns: 'none',
      }),
    ]);
    const heldChild = testEnvironment.model.scriptHeldTurnMatching(
      'worker request',
      (request) => (
        JSON.stringify(request.body).includes(childPrompt)
        && !request.functionCallOutputs.some((output) => output.callId === 'spawn_worker')
      ),
      [codexFinalAnswerMessage(childReply)],
    );
    testEnvironment.model.scriptTurnMatching(
      'parent spawn continuation',
      (request) => request.functionCallOutputs.some(
        (output) => output.callId === 'spawn_worker',
      ),
      [codexAssistantMessage(rootReply)],
    );

    await withIntegrationFixture('codex-scripted-late-subagent', async (fixture) => {
      const chatId = fixture.newChatId();
      const cursor = fixture.client.markEvents();
      const started = await fixture.client.startChat(liveCodexStartRequest({
        chatId,
        projectPath: fixture.dirs.project,
        command: 'Spawn the scripted worker and finish without waiting for it.',
        permissionMode: 'bypassPermissions',
      }));
      const childRequest = await heldChild.requested;
      expect(JSON.stringify(childRequest.body)).toContain(childPrompt);
      const terminal = await fixture.client.waitForTurnTerminal(chatId, started.turnId, {
        afterIndex: cursor,
        timeoutMs: 30_000,
      });
      expect(terminal.type).toBe('agent-run-finished');

      const beforeRelease = await fixture.client.getMessages(chatId);
      expect(completedActivities(beforeRelease.messages)).toEqual([]);
      const terminalIndex = fixture.client.eventsSince(cursor).findIndex((event) => (
        event.type === 'agent-run-finished'
        && event.chatId === chatId
        && event.turnId === started.turnId
      ));
      expect(terminalIndex).toBeGreaterThanOrEqual(0);

      heldChild.release();
      await fixture.client.waitForEvent(
        (event): event is Extract<typeof event, { type: 'chat-messages' }> => (
          event.type === 'chat-messages'
          && event.chatId === chatId
          && completedActivities(event.messages).length > 0
        ),
        'late completed Codex child activity',
        { afterIndex: cursor, timeoutMs: 30_000 },
      );

      const events = fixture.client.eventsSince(cursor);
      const lateIndex = events.findIndex((event) => (
        event.type === 'chat-messages'
        && event.chatId === chatId
        && completedActivities(event.messages).length > 0
      ));
      expect(lateIndex).toBeGreaterThan(terminalIndex);
      const settled = await fixture.client.getMessages(chatId);
      const completed = completedActivities(settled.messages);
      expect(completed).toHaveLength(1);
      expect(completed[0]?.details.target).toBe('/root/worker');
      expect(completed[0]?.details.agentStates).toEqual({
        '/root/worker': { status: 'completed' },
      });
      await Bun.sleep(100);
      const settledEvents = fixture.client.eventsSince(cursor);
      expect(settledEvents.filter((event) => (
        event.type === 'agent-run-finished'
        && event.chatId === chatId
        && event.turnId === started.turnId
      ))).toHaveLength(1);
      expect(settledEvents.reduce((count, event) => (
        event.type === 'chat-messages'
          ? count + completedActivities(event.messages).length
          : count
      ), 0)).toBe(1);
      testEnvironment.model.assertSettled();
    }, {
      serverEnvironment: testEnvironment.serverEnvironment,
      prepareWorkspace: async (directories) => {
        await testEnvironment.prepareWorkspace(directories, { multiAgentVersion: 'v2' });
        await appendFile(join(directories.home, '.codex', 'config.toml'), [
          '',
          '[features]',
          'multi_agent_v2 = true',
          '',
        ].join('\n'));
      },
    });
  }, 120_000);
});

function completedActivities(
  messages: Parameters<typeof messagesOfType>[0],
) {
  return messagesOfType(messages, 'codex-subagent-tool-use').filter((message) => (
    message.action === 'agent_status'
    && message.details.agentStates?.[message.details.target ?? '']?.status === 'completed'
  ));
}
