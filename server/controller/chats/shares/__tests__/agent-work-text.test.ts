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
    'stop job', 'send_input job Input: "go\\n"', 'To reviewer: Check the result.', 'failed: Compile; skipped: Publish; next: Recover',
  ]);
  const shared = renderSharedChatText({ messages, agentId: 'antigravity', model: 'synthetic', chatId: 'chat',
    shareToken: 'share', sharedAt: 'now', title: 'Work', projectPath: '/work' });
  for (const text of ['Background task: stop\njob', 'Background task: send_input\njob\nInput: "go\\n"',
    'Message to reviewer\nCheck the result.', '- [failed] Compile\n- [skipped] Publish\n- [pending] Recover']) {
    expect(shared).toContain(text);
  }
});

test('handoff distinguishes cleared, finished and actionable plans without calling a completed step current', () => {
  const plan = (todos: UpdatePlanToolUseMessage['todos']) => projectToolUseSummary(new UpdatePlanToolUseMessage('now', 'plan', todos));
  expect(plan(undefined).text).toBe('');
  expect(plan([]).text).toBe('Empty plan snapshot');
  expect(plan([{ content: 'Build', status: 'completed' }]).text).toBe('1 item(s), all completed');
  expect(plan([{ content: 'Build', status: 'completed' }, { content: 'Publish', status: 'pending' }]).text).toBe('next: Publish');
  const long = plan([{ content: 'x'.repeat(500), status: 'failed' },
    { content: 'Tests', status: 'skipped' }, { content: 'Repair', status: 'in_progress' }]);
  expect(long.text).toContain('...; skipped: Tests; current: Repair');
  expect(long.abridged).toBe(true);
});

test('handoffs and shares distinguish sending nothing, Enter, and literal spaces', () => {
  for (const input of ['', '\n', '  ']) {
    const row = new BackgroundTaskToolUseMessage('now', 'stdin', 'send_input', 'job', input);
    const label = `Input: ${JSON.stringify(input)}`;
    expect(projectToolUseSummary(row)).toEqual({ text: `send_input job ${label}`, abridged: false });
    expect(renderSharedChatText({ messages: [row], agentId: 'antigravity', model: 'synthetic', chatId: 'chat',
      shareToken: 'share', sharedAt: 'now', title: 'Work', projectPath: '/work' })).toContain(label);
  }
});
