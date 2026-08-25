import { describe, expect, it, mock } from 'bun:test';
import {
  SCHEDULED_PROMPT_CHAT_ID_TOKEN,
  SCHEDULED_PROMPT_MAX_LENGTH,
} from '../../../common/scheduled-prompts.ts';
import { ScheduledPromptDispatcher } from '../dispatcher.ts';

const CREATED_CHAT_ID = '1783725900000000';
const OTHER_CHAT_ID = '1783725900000001';
const AGENT_SETTINGS_BY_ID = {
  claude: {
    ownerId: 'claude',
    schemaVersion: 1,
    values: { claudeThinkingMode: 'auto' },
  },
  amp: {
    ownerId: 'amp',
    schemaVersion: 1,
    values: { ampAgentMode: 'smart' },
  },
};

function prompt(target, text = 'Review the current work') {
  return {
    id: 'prompt-a',
    schedule: { type: 'once', nextRunAt: '2030-01-01T09:00:00.000Z' },
    target,
    prompt: text,
    createdAt: '2029-01-01T00:00:00.000Z',
    updatedAt: '2029-01-01T00:00:00.000Z',
  };
}

describe('scheduled prompt dispatcher', () => {
  it('forwards complete new-chat configuration through chat commands', async () => {
    const calls = [];
    const allocate = mock(() => CREATED_CHAT_ID);
    const dispatcher = new ScheduledPromptDispatcher({
      chatIds: { allocate },
      commands: {
        async submitScheduledStart(input) {
          calls.push(input);
          return { chatId: CREATED_CHAT_ID };
        },
        async submitScheduledExistingChat() {
          throw new Error('unexpected');
        },
      },
    });
    const target = {
      type: 'new-chat',
      agentId: 'codex',
      projectPath: '/workspace/project',
      model: 'gpt-5',
      apiProviderId: null,
      modelEndpointId: null,
      modelProtocol: null,
      permissionMode: 'acceptEdits',
      thinkingMode: 'high',
      agentSettingsById: AGENT_SETTINGS_BY_ID,
      tags: ['qa', 'review-needed'],
    };

    const outcome = await dispatcher.dispatch(
      prompt(
        target,
        `Review ${SCHEDULED_PROMPT_CHAT_ID_TOKEN}; literal \\${SCHEDULED_PROMPT_CHAT_ID_TOKEN}; keep {{arguments}}`,
      ),
      '2030-01-01T09:00:00.000Z',
    );

    expect(calls).toHaveLength(1);
    expect(allocate).toHaveBeenCalledTimes(1);
    const { type: _type, ...chatConfig } = target;
    expect(calls[0]).toMatchObject({
      ...chatConfig,
      chatId: CREATED_CHAT_ID,
      command: `Review ${CREATED_CHAT_ID}; literal ${SCHEDULED_PROMPT_CHAT_ID_TOKEN}; keep {{arguments}}`,
    });
    expect(calls[0].clientRequestId).toBe('scheduled:prompt-a:2030-01-01T09:00:00.000Z');
    expect(calls[0].clientMessageId).toBe('scheduled-message:prompt-a:2030-01-01T09:00:00.000Z');
    expect(calls[0].tags).toEqual(['qa', 'review-needed']);
    expect(calls[0]).not.toHaveProperty('images');
    expect(outcome.message).toContain(CREATED_CHAT_ID);
    expect(outcome.message).not.toContain('Review');
  });

  it('fails when the command service does not return the allocated chat ID', async () => {
    const target = {
      type: 'new-chat',
      agentId: 'codex',
      projectPath: '/workspace/project',
      model: 'gpt-5',
      apiProviderId: null,
      modelEndpointId: null,
      modelProtocol: null,
      permissionMode: 'acceptEdits',
      thinkingMode: 'high',
      agentSettingsById: AGENT_SETTINGS_BY_ID,
      tags: [],
    };

    for (const result of [{}, { chatId: OTHER_CHAT_ID }]) {
      const dispatcher = new ScheduledPromptDispatcher({
        chatIds: { allocate: () => CREATED_CHAT_ID },
        commands: {
          async submitScheduledStart() {
            return result;
          },
          async submitScheduledExistingChat() {
            throw new Error('unexpected');
          },
        },
      });

      await expect(dispatcher.dispatch(prompt(target), '2030-01-01T09:00:00.000Z')).rejects.toThrow(
        'Scheduled chat start did not return the allocated chat ID',
      );
    }
  });

  it('reports queue, skip, and send outcomes for existing chats', async () => {
    for (const [type, expected] of [
      ['queued', 'queued for busy chat'],
      ['skipped-busy', 'skipped because chat'],
      ['sent', 'sent to chat'],
    ]) {
      const dispatcher = new ScheduledPromptDispatcher({
        chatIds: { allocate: () => CREATED_CHAT_ID },
        commands: {
          async submitScheduledStart() {
            throw new Error('unexpected');
          },
          async submitScheduledExistingChat(input) {
            expect(input.command).toBe(`Review in ${CREATED_CHAT_ID}`);
            return { type, chatId: '123', entryId: 'entry' };
          },
        },
      });
      const outcome = await dispatcher.dispatch(
        prompt(
          {
            type: 'existing-chat',
            chatId: CREATED_CHAT_ID,
            busyBehavior: 'queue',
          },
          `Review in ${SCHEDULED_PROMPT_CHAT_ID_TOKEN}`,
        ),
        '2030-01-01T09:00:00.000Z',
      );
      expect(outcome.message).toContain(expected);
      expect(outcome.message).not.toContain('Review in');
      expect(outcome.message).not.toContain(SCHEDULED_PROMPT_CHAT_ID_TOKEN);
    }
  });

  it('reports the domain error for a persisted existing-chat ID that renders over the limit', async () => {
    const submitScheduledExistingChat = mock(() => {
      throw new Error('unexpected');
    });
    const dispatcher = new ScheduledPromptDispatcher({
      chatIds: { allocate: () => CREATED_CHAT_ID },
      commands: {
        async submitScheduledStart() {
          throw new Error('unexpected');
        },
        submitScheduledExistingChat,
      },
    });
    const exactForCanonicalId = `${'x'.repeat(SCHEDULED_PROMPT_MAX_LENGTH - CREATED_CHAT_ID.length)}${SCHEDULED_PROMPT_CHAT_ID_TOKEN}`;

    await expect(
      dispatcher.dispatch(
        prompt(
          {
            type: 'existing-chat',
            chatId: `${CREATED_CHAT_ID}0`,
            busyBehavior: 'queue',
          },
          exactForCanonicalId,
        ),
        '2030-01-01T09:00:00.000Z',
      ),
    ).rejects.toThrow('Scheduled prompt exceeds the maximum length after variable expansion');
    expect(submitScheduledExistingChat).not.toHaveBeenCalled();
  });

  it('leaves prompts without scheduled variables unchanged', async () => {
    const calls = [];
    const dispatcher = new ScheduledPromptDispatcher({
      chatIds: { allocate: () => CREATED_CHAT_ID },
      commands: {
        async submitScheduledStart(input) {
          calls.push(input);
          return { chatId: CREATED_CHAT_ID };
        },
        async submitScheduledExistingChat() {
          throw new Error('unexpected');
        },
      },
    });

    await dispatcher.dispatch(
      prompt({
        type: 'new-chat',
        agentId: 'codex',
        projectPath: '/workspace/project',
        model: 'gpt-5',
        apiProviderId: null,
        modelEndpointId: null,
        modelProtocol: null,
        permissionMode: 'default',
        thinkingMode: 'default',
        agentSettingsById: AGENT_SETTINGS_BY_ID,
        tags: [],
      }),
      '2030-01-01T09:00:00.000Z',
    );

    expect(calls[0].command).toBe('Review the current work');
  });

  it('allocates and renders a fresh chat ID for each recurring occurrence', async () => {
    const allocatedIds = [CREATED_CHAT_ID, OTHER_CHAT_ID];
    const calls = [];
    const dispatcher = new ScheduledPromptDispatcher({
      chatIds: {
        allocate: mock(() => allocatedIds.shift()),
      },
      commands: {
        async submitScheduledStart(input) {
          calls.push(input);
          return { chatId: input.chatId };
        },
        async submitScheduledExistingChat() {
          throw new Error('unexpected');
        },
      },
    });
    const recurring = prompt(
      {
        type: 'new-chat',
        agentId: 'codex',
        projectPath: '/workspace/project',
        model: 'gpt-5',
        apiProviderId: null,
        modelEndpointId: null,
        modelProtocol: null,
        permissionMode: 'default',
        thinkingMode: 'default',
        agentSettingsById: AGENT_SETTINGS_BY_ID,
        tags: [],
      },
      `Review ${SCHEDULED_PROMPT_CHAT_ID_TOKEN}`,
    );
    recurring.schedule = {
      type: 'recurring',
      intervalDays: 1,
      nextRunAt: '2030-01-01T09:00:00.000Z',
      endAt: null,
    };

    await dispatcher.dispatch(recurring, '2030-01-01T09:00:00.000Z');
    await dispatcher.dispatch(recurring, '2030-01-02T09:00:00.000Z');

    expect(calls.map(({ chatId, command }) => ({ chatId, command }))).toEqual([
      { chatId: CREATED_CHAT_ID, command: `Review ${CREATED_CHAT_ID}` },
      { chatId: OTHER_CHAT_ID, command: `Review ${OTHER_CHAT_ID}` },
    ]);
  });

  it('rejects an oversized rendered prompt before allocating or submitting', async () => {
    const allocate = mock(() => CREATED_CHAT_ID);
    const submitScheduledStart = mock(async () => ({ chatId: CREATED_CHAT_ID }));
    const dispatcher = new ScheduledPromptDispatcher({
      chatIds: { allocate },
      commands: {
        submitScheduledStart,
        async submitScheduledExistingChat() {
          throw new Error('unexpected');
        },
      },
    });
    const oversized = `${'x'.repeat(SCHEDULED_PROMPT_MAX_LENGTH - SCHEDULED_PROMPT_CHAT_ID_TOKEN.length)}${SCHEDULED_PROMPT_CHAT_ID_TOKEN}`;

    await expect(
      dispatcher.dispatch(
        prompt(
          {
            type: 'new-chat',
            agentId: 'codex',
            projectPath: '/workspace/project',
            model: 'gpt-5',
            apiProviderId: null,
            modelEndpointId: null,
            modelProtocol: null,
            permissionMode: 'default',
            thinkingMode: 'default',
            agentSettingsById: AGENT_SETTINGS_BY_ID,
            tags: [],
          },
          oversized,
        ),
        '2030-01-01T09:00:00.000Z',
      ),
    ).rejects.toThrow('Scheduled prompt exceeds the maximum length after variable expansion');
    expect(allocate).not.toHaveBeenCalled();
    expect(submitScheduledStart).not.toHaveBeenCalled();
  });
});
