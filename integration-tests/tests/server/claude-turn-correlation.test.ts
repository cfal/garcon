import { chmod, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import type { AgentRunFailedMessage, ChatMessagesMessage } from '../../../common/ws-events.js';
import { withIntegrationFixture } from '../../support/integration-fixture.js';

function fakeClaudeSource(): string {
  return `#!${process.execPath}
const args = process.argv.slice(2);

if (args.includes('--version')) {
  console.log('2.1.220 (Claude Code)');
  process.exit(0);
}

if (args[0] === 'auth' && args[1] === 'status') {
  console.log(JSON.stringify({ loggedIn: true, authMethod: 'oauth_token' }));
  process.exit(0);
}

const emit = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
const decoder = new TextDecoder();
let buffer = '';
let firstUserMessage = true;

for await (const chunk of Bun.stdin.stream()) {
  buffer += decoder.decode(chunk, { stream: true });
  const lines = buffer.split('\\n');
  buffer = lines.pop() ?? '';

  for (const line of lines) {
    if (!line.trim()) continue;
    const input = JSON.parse(line);
    if (input.type !== 'user') continue;

    emit({
      type: 'command_lifecycle',
      command_uuid: input.uuid,
      state: 'queued',
      session_id: input.session_id,
    });

    if (firstUserMessage) {
      firstUserMessage = false;
      emit({
        type: 'system',
        subtype: 'init',
        session_id: input.session_id,
        model: 'haiku',
        capabilities: ['interrupt_receipt_v1', 'interrupt_cancel_queued_v1', 'msg_lifecycle_v1'],
      });
      if (input.message?.content === 'trigger setup failure') {
        emit({
          type: 'result',
          subtype: 'error_during_execution',
          terminal_reason: 'turn_setup_failed',
          is_error: true,
          duration_ms: 0,
          num_turns: 0,
          errors: ['queryParams builder failed: invalid runtime configuration'],
          session_id: input.session_id,
        });
        emit({
          type: 'command_lifecycle',
          command_uuid: input.uuid,
          state: 'cancelled',
          session_id: input.session_id,
        });
        continue;
      }
      emit({
        type: 'result',
        subtype: 'success',
        is_error: false,
        duration_ms: 108,
        num_turns: 0,
        result: '',
        stop_reason: null,
        session_id: input.session_id,
      });
    }

    emit({
      type: 'command_lifecycle',
      command_uuid: input.uuid,
      state: 'started',
      session_id: input.session_id,
    });
    emit({
      type: 'system',
      subtype: 'init',
      session_id: input.session_id,
      model: 'haiku',
    });
    emit({
      type: 'user',
      uuid: input.uuid,
      isReplay: true,
      message: input.message,
      session_id: input.session_id,
    });
    emit({
      type: 'assistant',
      content: [{ type: 'text', text: 'response after internal turn' }],
      session_id: input.session_id,
    });
    emit({
      type: 'result',
      subtype: 'success',
      is_error: false,
      duration_ms: 10,
      num_turns: 1,
      result: 'response after internal turn',
      stop_reason: 'end_turn',
      session_id: input.session_id,
    });
    emit({
      type: 'command_lifecycle',
      command_uuid: input.uuid,
      state: 'completed',
      session_id: input.session_id,
    });
  }
}
`;
}

describe('Claude turn correlation', () => {
  test('does not settle a user turn from an internal Claude result', async () => {
    const serverEnvironment: Record<string, string> = {};

    await withIntegrationFixture('claude-internal-turn-result', async (fixture) => {
      const chatId = fixture.newChatId();
      const clientRequestId = crypto.randomUUID();
      const cursor = fixture.client.markEvents();
      const accepted = await fixture.client.startChat({
        clientRequestId,
        clientMessageId: crypto.randomUUID(),
        chatId,
        agentId: 'claude',
        projectPath: fixture.dirs.project,
        model: 'haiku',
        permissionMode: 'default',
        thinkingMode: 'low',
        agentSettings: {
          ownerId: 'claude',
          schemaVersion: 1,
          values: {},
        },
        command: 'respond after the internal turn',
      });

      const assistant = await fixture.client.waitForEvent(
        (event): event is ChatMessagesMessage =>
          event.type === 'chat-messages'
          && event.chatId === chatId
          && event.messages.some((entry) =>
            entry.message.type === 'assistant-message'
            && entry.message.content === 'response after internal turn'),
        'Claude response after internal result',
        { afterIndex: cursor },
      );
      const terminal = await fixture.client.waitForTurnTerminal(chatId, accepted.turnId, {
        afterIndex: cursor,
      });

      expect(assistant.messages).toContainEqual(expect.objectContaining({
        message: expect.objectContaining({
          type: 'assistant-message',
          content: 'response after internal turn',
        }),
      }));
      expect(terminal).toMatchObject({
        type: 'agent-run-finished',
        chatId,
        clientRequestId,
        turnId: accepted.turnId,
      });
      expect(fixture.client.eventsSince(cursor)).not.toContainEqual(expect.objectContaining({
        type: 'agent-run-failed',
        chatId,
      }));
    }, {
      serverEnvironment,
      prepareWorkspace: async (directories) => {
        const fakeClaude = join(directories.root, 'fake-claude');
        await writeFile(fakeClaude, fakeClaudeSource());
        await chmod(fakeClaude, 0o755);
        serverEnvironment.CLAUDE_BINARY = fakeClaude;
      },
    });
  });

  test('fails a submitted input cancelled by Claude before it starts', async () => {
    const serverEnvironment: Record<string, string> = {};

    await withIntegrationFixture('claude-turn-setup-failure', async (fixture) => {
      const chatId = fixture.newChatId();
      const clientRequestId = crypto.randomUUID();
      const cursor = fixture.client.markEvents();
      const accepted = await fixture.client.startChat({
        clientRequestId,
        clientMessageId: crypto.randomUUID(),
        chatId,
        agentId: 'claude',
        projectPath: fixture.dirs.project,
        model: 'haiku',
        permissionMode: 'default',
        thinkingMode: 'low',
        agentSettings: {
          ownerId: 'claude',
          schemaVersion: 1,
          values: {},
        },
        command: 'trigger setup failure',
      });

      const terminal = await fixture.client.waitForTurnTerminal(chatId, accepted.turnId, {
        afterIndex: cursor,
      });
      expect(terminal).toMatchObject({
        type: 'agent-run-failed',
        chatId,
        clientRequestId,
        turnId: accepted.turnId,
      });
      expect((terminal as AgentRunFailedMessage).error)
        .toContain('queryParams builder failed: invalid runtime configuration');
    }, {
      serverEnvironment,
      prepareWorkspace: async (directories) => {
        const fakeClaude = join(directories.root, 'fake-claude');
        await writeFile(fakeClaude, fakeClaudeSource());
        await chmod(fakeClaude, 0o755);
        serverEnvironment.CLAUDE_BINARY = fakeClaude;
      },
    });
  });
});
