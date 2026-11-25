import { expect, test } from 'bun:test';
import { AgentMessageToolUseMessage, BackgroundTaskToolUseMessage, UpdatePlanToolUseMessage } from '../../../../../common/chat-types.ts';
import { projectToolUseSummary } from '../../../../../common/transcript-seed.ts';
import { renderSharedChatText } from '../transcript.ts';

test('handoffs and shares retain task intent, agent destinations, and unsuccessful plan steps', () => {
  const task = new BackgroundTaskToolUseMessage('now', 'call', 'stop', 'job');
  const input = new BackgroundTaskToolUseMessage('now', 'stdin', 'send_input', 'job', 'go\n');
  const send = new AgentMessageToolUseMessage('now', 'send', 'reviewer', 'Check the result.');
  const plan = new UpdatePlanToolUseMessage('now', 'plan', [
    { content: 'Compile', status: 'failed' }, { content: 'Publish', status: 'skipped' }, { content: 'Recover', status: 'pending' },
  ]);
  const messages = [task, input, send, plan];
  expect(messages.map(row => projectToolUseSummary(row).text)).toEqual([
    'stop job', 'send_input job go', 'To reviewer: Check the result.', 'failed: Compile; skipped: Publish; next: Recover',
  ]);
  const shared = renderSharedChatText({ messages, agentId: 'antigravity', model: 'synthetic', chatId: 'chat',
    shareToken: 'share', sharedAt: 'now', title: 'Work', projectPath: '/work' });
  for (const text of ['Background task: stop\njob', 'Background task: send_input\njob\ngo',
    'Message to reviewer\nCheck the result.', '- [failed] Compile\n- [skipped] Publish\n- [pending] Recover']) {
    expect(shared).toContain(text);
  }
});
