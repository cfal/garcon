import { expect, test } from 'bun:test';
import { CodexSubagentToolUseMessage, ToolResultMessage, UserMessage, codexSubagentSourceFingerprint, type ChatMessage } from '../../../../common/chat-types.js';
import { buildSubagentManagementModel } from '../../../../common/subagent-management.js';
import { DisplayStore } from '../store.js';
import { appendSubagentFact, prepareSubagentFrame, pruneSubagentFrame } from '../subagents.js';
import { querySubagents } from '../auxiliary-query.js';

const at = '2026-01-01T00:00:00.000Z';
test('pages a complete published generation while its replacement is built in bounded frames', () => {
  const store = new DisplayStore(':memory:');
  try {
    store.initialize('chat', 'view', 'server');
    for (let ordinal = 1; ordinal <= 65; ordinal++) {
      appendSubagentFact(store, ordinal, new CodexSubagentToolUseMessage(at, `spawn-${ordinal}`, 'spawn_agent', { taskName: `worker-${ordinal}` }));
    }
    while (prepareSubagentFrame(store, 65) < 65) {}
    const read = (watermark: number, afterOrder?: number) => querySubagents(store,
      { chatId: 'chat', transcriptViewId: 'view', limit: 50, ...(afterOrder === undefined ? {} : { afterOrder }) },
      { serverInstanceId: 'server', chatId: 'chat', transcriptViewId: 'view', watermark, sourceHead: 66 });
    const first = read(65), second = read(65, first.nextAfterOrder!);
    expect(first.entries.map(entry => [entry.name, entry.anchorOrdinal])).toEqual(
      Array.from({ length: 50 }, (_, i) => [`worker-${i + 1}`, i + 1]));
    expect(first.nextAfterOrder).toBe(50);
    expect(second.entries.map(entry => [entry.name, entry.anchorOrdinal])).toEqual(
      Array.from({ length: 15 }, (_, i) => [`worker-${i + 51}`, i + 51]));
    expect(second.nextAfterOrder).toBeNull();
    appendSubagentFact(store, 66, new CodexSubagentToolUseMessage(at, 'spawn-66', 'spawn_agent', { taskName: 'worker-66' }));
    let intermediateFrames = 0;
    while (prepareSubagentFrame(store, 66) < 66) {
      intermediateFrames++;
      expect(read(65)).toEqual(first);
      expect(read(65, first.nextAfterOrder!)).toEqual(second);
      expect(() => read(66)).toThrow('Subagent generation changed');
    }
    expect(intermediateFrames).toBeGreaterThan(1);
    expect(() => read(65)).toThrow(expect.objectContaining({ code: 'DISPLAY_STALE_WATERMARK' }));
    const replacement = read(66), tail = read(66, replacement.nextAfterOrder!);
    expect(replacement.entries).toEqual(first.entries);
    expect(tail.entries.map(entry => [entry.name, entry.anchorOrdinal])).toEqual(
      Array.from({ length: 16 }, (_, i) => [`worker-${i + 51}`, i + 51]));
    expect(tail.nextAfterOrder).toBeNull();
  } finally { store.close(); }
});

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

test.each([256 * 1024, 256 * 1024 - 2])('a %i-byte prefix respects the auxiliary budget in both passes', firstBytes => {
  const store = new DisplayStore(':memory:');
  try {
    store.initialize('chat', 'view', 'server');
    const first = new CodexSubagentToolUseMessage(at, 'first', 'spawn_agent', { taskName: 'first', message: '' });
    first.details.message = 'x'.repeat(firstBytes / 2 - JSON.stringify(first).length);
    expect(JSON.stringify(first).length * 2).toBe(firstBytes);
    appendSubagentFact(store, 1, first);
    appendSubagentFact(store, 2, new CodexSubagentToolUseMessage(at, 'second', 'spawn_agent', { taskName: 'second' }));

    expect(prepareSubagentFrame(store, 2)).toBe(0);
    expect(store.get('SELECT phase, cursor FROM auxiliary_control')).toEqual({ phase: 'aliases', cursor: 1 });
    expect(prepareSubagentFrame(store, 2)).toBe(0);
    expect(store.get('SELECT phase, cursor FROM auxiliary_control')).toEqual({ phase: 'reduce', cursor: 0 });
    expect(prepareSubagentFrame(store, 2)).toBe(0);
    expect(store.get('SELECT phase, cursor FROM auxiliary_control')).toEqual({ phase: 'reduce', cursor: 1 });
    expect(prepareSubagentFrame(store, 2)).toBe(2);
    expect(store.get('SELECT phase, cursor FROM auxiliary_control')).toEqual({ phase: 'idle', cursor: 0 });
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
