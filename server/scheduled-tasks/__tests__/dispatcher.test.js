import { describe, expect, it } from 'bun:test';
import { ScheduledTaskDispatcher } from '../dispatcher.ts';

function task(target) {
  return {
    id: 'task-a',
    schedule: { type: 'once', nextRunAt: '2030-01-01T09:00:00.000Z' },
    target,
    prompt: 'Review the current work',
    createdAt: '2029-01-01T00:00:00.000Z',
    updatedAt: '2029-01-01T00:00:00.000Z',
  };
}

describe('scheduled task dispatcher', () => {
  it('forwards complete new-chat configuration through chat commands', async () => {
    const calls = [];
    const dispatcher = new ScheduledTaskDispatcher({
      commands: {
        async submitStart(input) { calls.push(input); },
        async submitScheduledExistingChat() { throw new Error('unexpected'); },
      },
      chats: { getChat() { return null; } },
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
    };

    const outcome = await dispatcher.dispatch(task(target), '2030-01-01T09:00:00.000Z');

    expect(calls).toHaveLength(1);
    const { type: _type, ...chatConfig } = target;
    expect(calls[0]).toMatchObject({ ...chatConfig, command: 'Review the current work' });
    expect(calls[0].chatId).toMatch(/^\d+$/);
    expect(outcome.message).toContain(calls[0].chatId);
    expect(outcome.message).not.toContain('Review the current work');
  });

  it('reports queue, skip, and send outcomes for existing chats', async () => {
    for (const [type, expected] of [
      ['queued', 'queued for busy chat'],
      ['skipped-busy', 'skipped because chat'],
      ['sent', 'sent to chat'],
    ]) {
      const dispatcher = new ScheduledTaskDispatcher({
        commands: {
          async submitStart() { throw new Error('unexpected'); },
          async submitScheduledExistingChat() { return { type, chatId: '123', entryId: 'entry' }; },
        },
        chats: { getChat() { return {}; } },
      });
      const outcome = await dispatcher.dispatch(task({
        type: 'existing-chat',
        chatId: '123',
        busyBehavior: 'queue',
      }), '2030-01-01T09:00:00.000Z');
      expect(outcome.message).toContain(expected);
      expect(outcome.message).not.toContain('Review the current work');
    }
  });
});
