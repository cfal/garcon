import { expect, test } from 'bun:test';
import { CodexSubagentToolUseMessage, ToolResultMessage, UserMessage, codexSubagentSourceFingerprint, type ChatMessage } from '../../../../common/chat-types.js';
import { buildSubagentManagementModel } from '../../../../common/subagent-management.js';
import { DisplayStore } from '../store.js';
import { appendSubagentFact, prepareSubagentFrame, pruneSubagentFrame } from '../subagents.js';
import { querySubagents } from '../auxiliary-query.js';

const at = '2026-01-01T00:00:00.000Z';
test('disk-backed auxiliary prepasses and merges preserve the reference full-prefix reducer', () => {
  const messages: ChatMessage[] = [
    new UserMessage(at, 'Synthetic user text'),
    new CodexSubagentToolUseMessage(at, 'untrusted', 'agent_status', { target: '/root/worker', lifecycleSource: 'legacy',
      sourceFingerprint: codexSubagentSourceFingerprint('Synthetic user text'), agentStates: { '/root/worker': { status: 'errored' } } }),
    new CodexSubagentToolUseMessage(at, 'spawn', 'spawn_agent', { taskName: 'worker', model: 'generic-model' }),
    new ToolResultMessage(at, 'spawn', { agent_id: 'worker-thread-first', nickname: 'worker' }),
    new CodexSubagentToolUseMessage(at, 'event', 'agent_status', { threadId: 'worker-thread-second', target: '/root/other',
      lifecycleSource: 'structured', agentStates: { '/root/other': { status: 'completed', message: 'Generic completion' } } }),
    new CodexSubagentToolUseMessage(at, 'merge', 'send_message', { threadId: 'worker-thread-second', target: '/root/worker' }),
    new CodexSubagentToolUseMessage(at, 'interrupt', 'interrupt_agent', { target: '/root/worker' }),
    new CodexSubagentToolUseMessage(at, 'observe', 'wait_agent', { targets: ['/root/worker'] }),
    new CodexSubagentToolUseMessage(at, 'reset', 'followup_task', { target: '/root/worker', message: 'Generic follow-up' }),
    new ToolResultMessage(at, 'spawn', { agent_id: 'worker-thread-latest', nickname: 'worker' }),
  ];
  const store = new DisplayStore(':memory:');
  try {
    store.initialize('chat', 'view', 'server');
    for (const [index, message] of messages.entries()) appendSubagentFact(store, index + 1, message);
    while (prepareSubagentFrame(store, messages.length) < messages.length) {}
    const page = querySubagents(store, { chatId: 'chat', transcriptViewId: 'view', mode: 'navigation', limit: 50 },
      { serverInstanceId: 'server', chatId: 'chat', transcriptViewId: 'view', watermark: messages.length, sourceHead: messages.length });
    const expected = buildSubagentManagementModel(messages, { rootStatus: 'running' }).subagents;
    const normalized = (value: unknown) => JSON.parse(JSON.stringify(value, (key, value) => key === 'anchorId' || key === 'anchorOrdinal' ? undefined : value));
    expect(normalized(page.entries)).toEqual(normalized(expected));
    expect(page.entries.every(entry => Number.isSafeInteger(entry.anchorOrdinal))).toBe(true);
  } finally { store.close(); }
});

test('an oversized fact cannot publish an incomplete auxiliary prefix', () => {
  const store = new DisplayStore(':memory:');
  try {
    store.initialize('chat', 'view', 'server');
    appendSubagentFact(store, 1, new CodexSubagentToolUseMessage(at, 'first', 'spawn_agent', { taskName: 'first', message: 'x'.repeat(300000) }));
    appendSubagentFact(store, 2, new CodexSubagentToolUseMessage(at, 'second', 'spawn_agent', { taskName: 'second' }));
    expect(prepareSubagentFrame(store, 2)).toBe(0);
    let frames = 1;
    while (prepareSubagentFrame(store, 2) < 2) frames++;
    expect(frames).toBeGreaterThan(1);
    expect(store.all('SELECT * FROM auxiliary_entry WHERE generation = 2')).toHaveLength(2);
  } finally { store.close(); }
});

test('unrelated appends advance auxiliary coverage without rebuilding its published generation', () => {
  const store = new DisplayStore(':memory:');
  try {
    store.initialize('chat', 'view', 'server');
    appendSubagentFact(store, 1, new CodexSubagentToolUseMessage(at, 'spawn', 'spawn_agent', { taskName: 'worker' }));
    while (prepareSubagentFrame(store, 1) < 1) {}
    appendSubagentFact(store, 2, new ToolResultMessage(at, 'unrelated-command', { output: 'Generic result' }));
    expect(prepareSubagentFrame(store, 2)).toBe(2);
    expect(store.get('SELECT published, generation, phase FROM auxiliary_control')).toEqual({ published: 2, generation: 1, phase: 'idle' });
    expect(pruneSubagentFrame(store)).toBe(true);
    const identity = { serverInstanceId: 'server', chatId: 'chat', transcriptViewId: 'view', watermark: 1, sourceHead: 2 };
    expect(querySubagents(store, { chatId: 'chat', transcriptViewId: 'view', limit: 50 }, identity).entries).toHaveLength(1);
    expect(querySubagents(store, { chatId: 'chat', transcriptViewId: 'view', limit: 50 }, { ...identity, watermark: 2 }).entries).toHaveLength(1);
  } finally { store.close(); }
});
