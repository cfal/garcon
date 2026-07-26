import { chmod, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import type {
  AgentRunFailedMessage,
  ChatMessagesMessage,
  PendingUserInputUpdatedMessage,
} from '../../../common/ws-events.js';
import { withIntegrationFixture } from '../../support/integration-fixture.js';

function fakeClaudeSource(): string {
  return `#!${process.execPath}
const { appendFileSync, existsSync } = await import('node:fs');
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
let processing = false;
let drainPromise = Promise.resolve();
const pendingInputs = [];
const interruptedInputs = new Set();
const startedInputs = new Set();
let currentInput = null;
const receivedPath = process.env.CLAUDE_TEST_RECEIVED_PATH;
const releasePath = process.env.CLAUDE_TEST_RELEASE_PATH;
const internalResultPath = process.env.CLAUDE_TEST_INTERNAL_RESULT_PATH;
const startedPath = process.env.CLAUDE_TEST_STARTED_PATH;

const recordInput = (input) => {
  if (!receivedPath) return;
  appendFileSync(receivedPath, JSON.stringify({
    uuid: input.uuid,
    content: input.message?.content,
  }) + '\\n');
};

const waitForRelease = async (inputUuid) => {
  if (!releasePath) return;
  if (internalResultPath) appendFileSync(internalResultPath, 'emitted\\n');
  while (!existsSync(releasePath) && !interruptedInputs.has(inputUuid)) await Bun.sleep(5);
};

const processInput = async (input) => {
  currentInput = input;
  emit({
    type: 'command_lifecycle',
    command_uuid: input.uuid,
    state: 'queued',
    session_id: input.session_id,
  });

  if (
    input.message?.content === 'trigger malformed output'
    || input.message?.content === 'trigger process crash'
  ) {
    emit({
      type: 'command_lifecycle',
      command_uuid: input.uuid,
      state: 'started',
      session_id: input.session_id,
    });
    if (input.message.content === 'trigger malformed output') {
      process.stdout.write('{"type":}\\n');
    } else {
      process.exit(23);
    }
    return;
  }

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
      return;
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
    await waitForRelease(input.uuid);
    if (interruptedInputs.has(input.uuid)) return;
  }

  const content = input.message?.content;
  const response = content === 'respond after the internal turn'
    ? 'response after internal turn'
    : 'response:' + content;
  emit({
    type: 'command_lifecycle',
    command_uuid: input.uuid,
    state: 'started',
    session_id: input.session_id,
  });
  startedInputs.add(input.uuid);
  if (startedPath) appendFileSync(startedPath, input.uuid + '\\n');
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
  if (content === 'trigger active abort') {
    while (!interruptedInputs.has(input.uuid)) await Bun.sleep(5);
    return;
  }
  emit({
    type: 'assistant',
    content: [{ type: 'text', text: response }],
    session_id: input.session_id,
  });
  emit({
    type: 'result',
    subtype: 'success',
    is_error: false,
    duration_ms: 10,
    num_turns: 1,
    result: response,
    user_message_uuid: input.uuid,
    stop_reason: 'end_turn',
    session_id: input.session_id,
  });
  emit({
    type: 'command_lifecycle',
    command_uuid: input.uuid,
    state: 'completed',
    session_id: input.session_id,
  });
};

const drain = async () => {
  if (processing) return;
  processing = true;
  try {
    while (pendingInputs.length > 0) await processInput(pendingInputs.shift());
  } finally {
    processing = false;
    if (pendingInputs.length > 0) drainPromise = drain();
  }
};

for await (const chunk of Bun.stdin.stream()) {
  buffer += decoder.decode(chunk, { stream: true });
  const lines = buffer.split('\\n');
  buffer = lines.pop() ?? '';

  for (const line of lines) {
    if (!line.trim()) continue;
    const input = JSON.parse(line);
    if (input.type === 'control_request' && input.request?.subtype === 'interrupt') {
      const activeInput = currentInput;
      const inputUuid = activeInput?.uuid;
      if (!inputUuid) {
        emit({
          type: 'control_response',
          response: {
            subtype: 'success',
            request_id: input.request_id,
            response: { cancelled: [], still_queued: [] },
          },
        });
        continue;
      }

      interruptedInputs.add(inputUuid);
      if (!startedInputs.has(inputUuid)) {
        emit({
          type: 'command_lifecycle',
          command_uuid: inputUuid,
          state: 'cancelled',
          session_id: activeInput.session_id,
        });
        emit({
          type: 'control_response',
          response: {
            subtype: 'success',
            request_id: input.request_id,
            response: { cancelled: [inputUuid], still_queued: [] },
          },
        });
        continue;
      }

      emit({
        type: 'control_response',
        response: {
          subtype: 'success',
          request_id: input.request_id,
          response: { cancelled: [], still_queued: [] },
        },
      });
      emit({
        type: 'result',
        subtype: 'error_during_execution',
        terminal_reason: 'aborted_streaming',
        is_error: true,
        duration_ms: 1,
        num_turns: 1,
        result: '',
        user_message_uuid: inputUuid,
        session_id: activeInput.session_id,
      });
      emit({
        type: 'command_lifecycle',
        command_uuid: inputUuid,
        state: 'cancelled',
        session_id: activeInput.session_id,
      });
      continue;
    }
    if (
      input.type === 'control_request'
      && (input.request?.subtype === 'initialize' || input.request?.subtype === 'set_model')
    ) {
      emit({
        type: 'control_response',
        response: {
          subtype: 'success',
          request_id: input.request_id,
          response: { commands: [], capabilities: ['interrupt_cancel_queued_v1'] },
        },
      });
      continue;
    }
    if (input.type !== 'user') continue;
    recordInput(input);
    pendingInputs.push(input);
    if (!processing) drainPromise = drain();
  }
}
await drainPromise;
`;
}

async function waitForFile(filePath: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (await Bun.file(filePath).exists()) return;
    await Bun.sleep(10);
  }
  throw new Error(`Timed out waiting for ${filePath}`);
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

  test('keeps a consecutive message in Garcon until the correlated turn finishes', async () => {
    const serverEnvironment: Record<string, string> = {};
    let receivedPath = '';
    let releasePath = '';
    let internalResultPath = '';

    await withIntegrationFixture('claude-consecutive-turn-queue', async (fixture) => {
      const chatId = fixture.newChatId();
      const firstCursor = fixture.client.markEvents();
      const first = await fixture.client.startChat({
        clientRequestId: crypto.randomUUID(),
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
        command: 'queue-first',
      });
      await waitForFile(internalResultPath);

      const queueCursor = fixture.client.markEvents();
      const queued = await fixture.client.enqueueNew(chatId, 'queue-second');
      expect(queued.control.queue.entries.map((entry) => entry.content)).toEqual(['queue-second']);

      const receivedBeforeRelease = (await readFile(receivedPath, 'utf8'))
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line).content);
      expect(receivedBeforeRelease).toEqual(['queue-first']);
      expect(fixture.client.eventsSince(firstCursor)).not.toContainEqual(expect.objectContaining({
        type: 'agent-run-finished',
        chatId,
        turnId: first.turnId,
      }));

      await writeFile(releasePath, 'release');
      expect((await fixture.client.waitForTurnTerminal(chatId, first.turnId, {
        afterIndex: firstCursor,
      })).type).toBe('agent-run-finished');
      const pending = await fixture.client.waitForEvent(
        (event): event is PendingUserInputUpdatedMessage =>
          event.type === 'pending-user-input-updated'
          && event.input.chatId === chatId
          && event.input.content === 'queue-second',
        'queued Claude follow-up identity',
        { afterIndex: queueCursor },
      );
      expect((await fixture.client.waitForTurnTerminal(chatId, pending.input.turnId!, {
        afterIndex: queueCursor,
      })).type).toBe('agent-run-finished');

      const receivedAfterRelease = (await readFile(receivedPath, 'utf8'))
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line).content);
      expect(receivedAfterRelease).toEqual(['queue-first', 'queue-second']);
      expect((await fixture.client.getExecutionControl(chatId)).queue.entries).toEqual([]);
    }, {
      serverEnvironment,
      prepareWorkspace: async (directories) => {
        const fakeClaude = join(directories.root, 'fake-claude');
        receivedPath = join(directories.root, 'claude-received.jsonl');
        releasePath = join(directories.root, 'release-first-turn');
        internalResultPath = join(directories.root, 'internal-result-emitted');
        await writeFile(fakeClaude, fakeClaudeSource());
        await chmod(fakeClaude, 0o755);
        serverEnvironment.CLAUDE_BINARY = fakeClaude;
        serverEnvironment.CLAUDE_TEST_RECEIVED_PATH = receivedPath;
        serverEnvironment.CLAUDE_TEST_RELEASE_PATH = releasePath;
        serverEnvironment.CLAUDE_TEST_INTERNAL_RESULT_PATH = internalResultPath;
      },
    });
  });

  test('confirms cancellation of a queued input before it starts', async () => {
    const serverEnvironment: Record<string, string> = {};
    let releasePath = '';
    let internalResultPath = '';

    await withIntegrationFixture('claude-pre-start-cancellation', async (fixture) => {
      const chatId = fixture.newChatId();
      const accepted = await fixture.client.startChat({
        clientRequestId: crypto.randomUUID(),
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
        command: 'trigger pre-start abort',
      });
      await waitForFile(internalResultPath);
      const cursor = fixture.client.markEvents();

      const stopped = await fixture.client.stopChat({
        clientRequestId: crypto.randomUUID(),
        chatId,
      });
      expect(stopped.stopped).toBe(true);
      expect((await fixture.client.waitForTurnTerminal(chatId, accepted.turnId, {
        afterIndex: cursor,
      })).type).toBe('agent-run-finished');
      expect(fixture.client.eventsSince(cursor)).not.toContainEqual(expect.objectContaining({
        type: 'agent-run-failed',
        chatId,
        turnId: accepted.turnId,
      }));
    }, {
      serverEnvironment,
      prepareWorkspace: async (directories) => {
        const fakeClaude = join(directories.root, 'fake-claude');
        releasePath = join(directories.root, 'hold-pre-start-turn');
        internalResultPath = join(directories.root, 'pre-start-internal-result');
        await writeFile(fakeClaude, fakeClaudeSource());
        await chmod(fakeClaude, 0o755);
        serverEnvironment.CLAUDE_BINARY = fakeClaude;
        serverEnvironment.CLAUDE_TEST_RELEASE_PATH = releasePath;
        serverEnvironment.CLAUDE_TEST_INTERNAL_RESULT_PATH = internalResultPath;
      },
    });
  });

  test('stops an active correlated input without reporting provider failure', async () => {
    const serverEnvironment: Record<string, string> = {};
    let startedPath = '';

    await withIntegrationFixture('claude-active-cancellation', async (fixture) => {
      const chatId = fixture.newChatId();
      const accepted = await fixture.client.startChat({
        clientRequestId: crypto.randomUUID(),
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
        command: 'trigger active abort',
      });
      await waitForFile(startedPath);
      const cursor = fixture.client.markEvents();

      const stopped = await fixture.client.stopChat({
        clientRequestId: crypto.randomUUID(),
        chatId,
      });
      expect(stopped.stopped).toBe(true);
      expect((await fixture.client.waitForTurnTerminal(chatId, accepted.turnId, {
        afterIndex: cursor,
      })).type).toBe('agent-run-finished');
      expect(fixture.client.eventsSince(cursor)).not.toContainEqual(expect.objectContaining({
        type: 'agent-run-failed',
        chatId,
        turnId: accepted.turnId,
      }));
    }, {
      serverEnvironment,
      prepareWorkspace: async (directories) => {
        const fakeClaude = join(directories.root, 'fake-claude');
        startedPath = join(directories.root, 'active-input-started');
        await writeFile(fakeClaude, fakeClaudeSource());
        await chmod(fakeClaude, 0o755);
        serverEnvironment.CLAUDE_BINARY = fakeClaude;
        serverEnvironment.CLAUDE_TEST_STARTED_PATH = startedPath;
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

  for (const scenario of [
    {
      name: 'malformed CLI output',
      command: 'trigger malformed output',
      error: 'malformed JSON',
    },
    {
      name: 'an unexpected CLI process exit',
      command: 'trigger process crash',
      error: 'Claude CLI',
    },
  ]) {
    test(`fails an active turn on ${scenario.name}`, async () => {
      const serverEnvironment: Record<string, string> = {};

      await withIntegrationFixture(`claude-${scenario.command.replaceAll(' ', '-')}`, async (fixture) => {
        const chatId = fixture.newChatId();
        const cursor = fixture.client.markEvents();
        const accepted = await fixture.client.startChat({
          clientRequestId: crypto.randomUUID(),
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
          command: scenario.command,
        });

        const terminal = await fixture.client.waitForTurnTerminal(chatId, accepted.turnId, {
          afterIndex: cursor,
        });
        expect(terminal.type).toBe('agent-run-failed');
        expect((terminal as AgentRunFailedMessage).error).toContain(scenario.error);
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
  }
});
