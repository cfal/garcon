import { describe, expect, it } from 'bun:test';
import { ScheduledPromptDispatcher } from '../dispatcher.ts';

const CREATED_CHAT_ID = '1783725900000000';

function prompt(target) {
  return {
    id: 'prompt-a',
    schedule: { type: 'once', nextRunAt: '2030-01-01T09:00:00.000Z' },
    target,
    prompt: 'Review the current work',
    createdAt: '2029-01-01T00:00:00.000Z',
    updatedAt: '2029-01-01T00:00:00.000Z',
  };
}

describe('scheduled prompt dispatcher', () => {
  it('forwards complete new-chat configuration through chat commands', async () => {
    const calls = [];
    const dispatcher = new ScheduledPromptDispatcher({
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
      claudeThinkingMode: 'auto',
      ampAgentMode: 'smart',
      tags: ['qa', 'review-needed'],
    };

    const outcome = await dispatcher.dispatch(prompt(target), '2030-01-01T09:00:00.000Z');

    expect(calls).toHaveLength(1);
    const { type: _type, ...chatConfig } = target;
    expect(calls[0]).toMatchObject({
      ...chatConfig,
      command: 'Review the current work',
    });
    expect(calls[0]).not.toHaveProperty('chatId');
    expect(calls[0].tags).toEqual(['qa', 'review-needed']);
    expect(calls[0]).not.toHaveProperty('images');
    expect(outcome.message).toContain(CREATED_CHAT_ID);
    expect(outcome.message).not.toContain('Review the current work');
  });

  it('fails when the command service does not return the allocated chat ID', async () => {
    const dispatcher = new ScheduledPromptDispatcher({
      commands: {
        async submitScheduledStart() {
          return {};
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
      claudeThinkingMode: 'auto',
      ampAgentMode: 'smart',
      tags: [],
    };

    await expect(dispatcher.dispatch(prompt(target), '2030-01-01T09:00:00.000Z')).rejects.toThrow(
      'Scheduled chat start did not return a chat ID',
    );
  });

  it('reports queue, skip, and send outcomes for existing chats', async () => {
    for (const [type, expected] of [
      ['queued', 'queued for busy chat'],
      ['skipped-busy', 'skipped because chat'],
      ['sent', 'sent to chat'],
    ]) {
      const dispatcher = new ScheduledPromptDispatcher({
        commands: {
          async submitScheduledStart() {
            throw new Error('unexpected');
          },
          async submitScheduledExistingChat() {
            return { type, chatId: '123', entryId: 'entry' };
          },
        },
      });
      const outcome = await dispatcher.dispatch(
        prompt({
          type: 'existing-chat',
          chatId: '123',
          busyBehavior: 'queue',
        }),
        '2030-01-01T09:00:00.000Z',
      );
      expect(outcome.message).toContain(expected);
      expect(outcome.message).not.toContain('Review the current work');
    }
  });
});
