import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { AgentRunFailedMessage } from '../../../common/ws-events.js';
import { assistantContents } from '../../support/chat-assertions.js';
import { claudeText } from '../../support/fake-claude-model.js';
import { withIntegrationFixture } from '../../support/integration-fixture.js';
import {
  LIVE_TURN_TIMEOUT_MS,
  liveMarker,
  waitForVisibleResponse,
} from '../../support/live-agent.js';
import {
  liveClaudeRunRequest,
  liveClaudeStartRequest,
} from '../../support/live-claude.js';
import { waitForPersistedNativeSession } from '../../support/persisted-chat.js';
import {
  startScriptedClaudeTestEnvironment,
  type ScriptedClaudeTestEnvironment,
} from '../../support/scripted-claude.js';

// The real CLI executes a forwarded /clear in print/stream-json mode and answers with a
// conversation_reset frame (CLI >= 2.1.229). The runtime must fail the clearing turn with an
// actionable message and keep the chat's native binding so the durable transcript keeps naming
// a session the next turn can resume.
describe('scripted Claude conversation reset', () => {
  let environment: ScriptedClaudeTestEnvironment | undefined;

  beforeAll(async () => {
    environment = await startScriptedClaudeTestEnvironment();
  });

  afterAll(() => {
    environment?.dispose();
  });

  test('[TLV5-CONVERSATION-RESET.01-CLAUDE-SCRIPTED-01] fails a clearing turn and resumes the unchanged native binding', async () => {
    if (!environment) throw new Error('Scripted Claude environment was not initialized.');
    const testEnvironment = environment;
    const openingReply = liveMarker('RESET_OPENING_REPLY');
    const recoveredReply = liveMarker('RESET_RECOVERED_REPLY');
    testEnvironment.model.scriptTurn([claudeText(openingReply)]);
    testEnvironment.model.scriptTurn([claudeText(recoveredReply)]);

    await withIntegrationFixture('claude-conversation-reset', async (fixture) => {
      const chatId = fixture.newChatId();
      const openingCursor = fixture.client.markEvents();
      const opening = await fixture.client.startChat(liveClaudeStartRequest({
        chatId,
        projectPath: fixture.dirs.project,
        command: 'Establish the scripted native session.',
        permissionMode: 'bypassPermissions',
      }));
      await waitForVisibleResponse({
        fixture,
        chatId,
        turnId: opening.turnId,
        marker: openingReply,
        afterIndex: openingCursor,
      });
      const binding = await waitForPersistedNativeSession({
        directories: fixture.dirs,
        chatId,
        agentId: 'claude',
      });

      const cleared = await fixture.client.runChat(liveClaudeRunRequest({
        chatId,
        command: '/clear',
        permissionMode: 'bypassPermissions',
      }));
      const failed = await fixture.client.waitForTurnTerminal(chatId, cleared.turnId, {
        timeoutMs: LIVE_TURN_TIMEOUT_MS,
      });
      expect(failed.type).toBe('agent-run-failed');
      expect((failed as AgentRunFailedMessage).error).toContain('cleared the conversation mid-turn');
      expect((failed as AgentRunFailedMessage).error).not.toContain('Unexpected Claude session ID');
      const bindingAfterReset = await waitForPersistedNativeSession({
        directories: fixture.dirs,
        chatId,
        agentId: 'claude',
      });
      expect(bindingAfterReset.agentSessionId).toBe(binding.agentSessionId);
      expect(bindingAfterReset.nativeSession).toEqual(binding.nativeSession);

      const recoveredCursor = fixture.client.markEvents();
      const recovered = await fixture.client.runChat(liveClaudeRunRequest({
        chatId,
        command: 'Continue from the durable transcript.',
        permissionMode: 'bypassPermissions',
      }));
      await waitForVisibleResponse({
        fixture,
        chatId,
        turnId: recovered.turnId,
        marker: recoveredReply,
        afterIndex: recoveredCursor,
      });
      const bindingAfterRecovery = await waitForPersistedNativeSession({
        directories: fixture.dirs,
        chatId,
        agentId: 'claude',
      });
      expect(bindingAfterRecovery.agentSessionId).toBe(binding.agentSessionId);

      const transcript = await fixture.client.getMessages(chatId);
      expect(assistantContents(transcript.messages)).toEqual(expect.arrayContaining([
        openingReply,
        recoveredReply,
      ]));
      testEnvironment.model.assertSettled();
    }, {
      serverEnvironment: testEnvironment.serverEnvironment,
    });
  }, 120_000);
});
