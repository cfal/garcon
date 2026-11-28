import { expect, test } from 'bun:test';
import { convertHistoryLines, parseHistoryEntry } from './history-loader.ts';

const user = (content: unknown, extras = {}) => ({
  sessionId: 'synthetic-session', type: 'user', message: { role: 'user', content }, ...extras,
});
const assistant = (content: unknown, extras = {}) => ({
  sessionId: 'synthetic-session', type: 'assistant', message: { role: 'assistant', content }, ...extras,
});
const queued = (prompt: unknown, provenance = {}, extras = {}) => ({
  sessionId: 'synthetic-session', type: 'attachment', uuid: 'synthetic-queued',
  timestamp: '2026-07-21T14:00:00.000Z',
  attachment: {
    type: 'queued_command', commandMode: 'prompt', prompt,
    timestamp: '2026-07-21T14:00:01.000Z', ...provenance,
  },
  ...extras,
});
const rows = (...entries: unknown[]) => entries.map((entry) => JSON.stringify(entry));

test('native entry presence, recovered suffixes, and source identity', () => {
  const raw = JSON.stringify(user('Synthetic', { uuid: '', id: 'synthetic-id' }));
  expect(parseHistoryEntry(raw, 3)?.source).toEqual({ entryId: 'synthetic-id', lineNumber: 3 });
  expect(parseHistoryEntry(raw + '{"unwritten":', 5)?.source?.lineNumber).toBe(5);
  expect(parseHistoryEntry(raw + JSON.stringify(user('Synthetic duplicate')), 6)?.entry.message)
    .toEqual({ role: 'user', content: 'Synthetic' });
  expect(parseHistoryEntry('{"uuid":"synthetic","sessionId":""}', 1)).toBeNull();
  expect(parseHistoryEntry('{"sessionId":', 1)).toBeNull();
  expect(parseHistoryEntry('{"sessionId":"synthetic","uuid":"  ","id":"not-selected"}', 0)?.source).toBeNull();
});

test('native user provenance, queued steering, and mention cleanup', () => {
  const steering = (text: string) => ({
    type: 'text', text: 'The user sent steering guidance for the active task:\n\n' + text,
  });
  expect(convertHistoryLines(rows(
    user('Provider message', { origin: { kind: 'future-provider-kind' } }),
    user('Synthetic @file\n\nReferenced file contents from @file mentions:\n\nsynthetic body', {
      origin: { kind: 'human' }, uuid: 'human-1',
    }),
    queued('Queued human', { origin: { kind: 'human' } }, { origin: { kind: 'provider' } }),
    queued('Queued provider', { origin: { kind: 'provider' } }, { uuid: 'filtered-queue' }),
    queued([steering('  One  '), steering('Two')], { isMeta: true, origin: { kind: 'provider' } }, {
      uuid: 'queued-steering', isMeta: true,
    }),
    user('Warmup'),
    user('<command-name>/clear</command-name>'),
    { ...user('Synthetic @file'), type: 'api-request-blob' },
  )).map(({ message }) => 'content' in message ? message.content : null)).toEqual([
    'Queued human', '  One  ', 'Two', 'Synthetic @file',
  ]);
});

test('native content parts, compaction pairing, tool metadata, and chronological dedupe', () => {
  const boundary = {
    sessionId: 'synthetic-session', type: 'system', subtype: 'compact_boundary',
    timestamp: '2026-07-21T14:00:02.000Z',
    compactMetadata: { trigger: 'auto', preTokens: 40, postTokens: 15 },
  };
  expect(convertHistoryLines(rows(
    boundary,
    assistant('Synthetic late', { timestamp: '2026-07-21T14:00:10.000Z', uuid: 'assistant-1' }),
    user('Summary: Synthetic summary', {
      isCompactSummary: true, timestamp: '2026-07-21T14:00:01.000Z', uuid: 'summary-1',
    }),
    assistant([
      { type: 'thinking', thinking: 'Synthetic reasoning' },
      { type: 'text', text: ' Synthetic reply ' },
      { type: 'tool_use', id: 'tool-1', name: 'Read', input: { file_path: '/workspace/synthetic.txt' } },
    ], { timestamp: '2026-07-21T14:00:03.000Z', uuid: 'assistant-1' }),
    user([
      { type: 'tool_result', tool_use_id: 'tool-1', content: [{ type: 'text', text: 'Synthetic result' }] },
      { type: 'text', text: 'Synthetic prompt' },
    ], { toolUseResult: { elapsedMs: 0.125 }, uuid: 'user-2' }),
    assistant('Invalid API key: synthetic'),
    assistant([], { isApiErrorMessage: true, error: { message: 'Synthetic failure', delay: 1e21 } }),
  )).map(({ message }) => message.type)).toEqual([
    'compaction', 'thinking', 'assistant-message', 'read-tool-use', 'tool-result', 'user-message', 'error',
  ]);
});
