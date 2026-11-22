import { describe, expect, test } from 'bun:test';
import { isMalformedUsage, type UsageRecord } from '@garcon/server-agent-common/usage/usage-record';
import { priceUsageRecord } from '@garcon/server-agent-common/usage/usage-pricing';
import { codexUsageFormat, createCodexUsageState, parseCodexUsageLine as parseLine, type CodexUsageState } from '../usage-format.js';

// Parses a line that must not be malformed.
function parseCodexUsageLine(line: string, state: CodexUsageState): UsageRecord | null {
  const result = parseLine(line, state);
  if (result !== null && isMalformedUsage(result)) throw new Error('Unexpected malformed usage');
  return result;
}

function isMalformed(line: string, state: CodexUsageState): boolean {
  const result = parseLine(line, state);
  return result !== null && isMalformedUsage(result);
}

const SESSION_ID = '00000000-0000-7000-8000-0000000000c1';
const PARENT_THREAD_ID = '00000000-0000-4000-8000-0000000000c0';
const COPY_THREAD_ID = '00000000-0000-4000-8000-0000000000c2';
const forkOrigins = [
  ['native fork', { forked_from_id: PARENT_THREAD_ID }],
  ['subagent spawn', { source: { subagent: { thread_spawn: { parent_thread_id: PARENT_THREAD_ID } } } }],
] as const;
const sessionMeta = (payload: Record<string, unknown> = {}, timestamp = '2026-10-01T05:17:41.289Z') =>
  JSON.stringify({ type: 'session_meta', timestamp, payload: { id: SESSION_ID, ...payload } });
const turnContext = (model = 'gpt-6-sol', turnId?: string) =>
  JSON.stringify({ type: 'turn_context', timestamp: '2026-10-01T05:17:42.694Z', payload: { model, turn_id: turnId } });
const threadSettings = (serviceTier: string, model = 'gpt-6-sol') =>
  JSON.stringify({ type: 'event_msg', timestamp: '2026-10-01T05:17:43.000Z', payload: { type: 'thread_settings_applied', thread_settings: { model, service_tier: serviceTier } } });
const turnStarted = (id: string, type = 'task_started') =>
  JSON.stringify({ type: 'event_msg', timestamp: '2026-10-01T05:17:42Z', payload: { type, turn_id: id } });

function counters(input: number, output: number, extra: Partial<Record<string, number>> = {}) {
  return {
    input_tokens: input,
    cached_input_tokens: 0,
    cache_write_input_tokens: 0,
    output_tokens: output,
    reasoning_output_tokens: 0,
    total_tokens: input + output,
    ...extra,
  };
}

function tokenCount(last: unknown, total?: unknown, timestamp = '2026-10-01T05:17:49.919Z'): string {
  return JSON.stringify({ type: 'event_msg', timestamp, payload: { type: 'token_count', info: { last_token_usage: last, total_token_usage: total } } });
}

// Mirrors the pinned 0.169.0 rollout line written for each billed response.
function usageRecordLine(
  responseId: unknown, usage: unknown, timestamp = '2026-10-01T05:17:49.900Z',
  turnId = 'turn-1', threadId: string | null = SESSION_ID,
): string {
  return JSON.stringify({
    type: 'token_usage_record',
    timestamp,
    payload: {
      thread_id: threadId ?? undefined, turn_id: turnId, session_id: SESSION_ID,
      root_turn_id: turnId, response_id: responseId, usage,
    },
  });
}

function started(meta = sessionMeta()): CodexUsageState {
  const state = createCodexUsageState();
  parseCodexUsageLine(meta, state);
  parseCodexUsageLine(turnContext(), state);
  return state;
}

const afterFork = (ms: number) => new Date(Date.parse('2026-10-01T05:17:42.694Z') + ms).toISOString();

function startedFork(meta: Record<string, unknown> = {}): CodexUsageState {
  return started(sessionMeta({ forked_from_id: PARENT_THREAD_ID, ...meta }, afterFork(0)));
}

describe('Codex usage lines', () => {
  test.each(['task_started', 'turn_started'])('%s freezes the tier before context, including early compaction', (type) => {
    const state = createCodexUsageState();
    parseCodexUsageLine(turnContext('gpt-6-sol', 'previous'), state);
    parseCodexUsageLine(threadSettings('priority'), state);
    const start = turnStarted('turn-1', type);
    expect(codexUsageFormat.lineMarkers.some((marker) => start.includes(marker))).toBe(true);
    parseCodexUsageLine(start, state);
    parseCodexUsageLine(threadSettings('ultrafast'), state);
    const compact = parseCodexUsageLine(usageRecordLine('compact', counters(0, 1_000_000)), state)!;
    expect(priceUsageRecord(compact)?.costUsd).toBe(20);
    parseCodexUsageLine(turnContext('gpt-6-sol', 'turn-1'), state);
    expect(parseCodexUsageLine(usageRecordLine('ordinary', counters(100, 10)), state)?.speed).toBe('fast');
  });

  test('does not guess the initial tier from an edit before the first context, or the compactor across a model switch', () => {
    const state = createCodexUsageState();
    parseCodexUsageLine(turnStarted('turn-1'), state);
    parseCodexUsageLine(threadSettings('ultrafast', 'gpt-6.2-astra'), state);
    parseCodexUsageLine(turnContext('gpt-6.2-astra', 'turn-1'), state);
    expect(parseCodexUsageLine(usageRecordLine('first', counters(1, 1)), state)?.speed).toBe('unknown');
    parseCodexUsageLine(threadSettings('priority', 'gpt-6.2-sol'), state);
    parseCodexUsageLine(turnStarted('turn-2'), state);
    const compact = parseCodexUsageLine(usageRecordLine('compact', counters(10, 3), undefined, 'turn-2'), state)!;
    expect(compact.totals.outputTokens).toBe(3);
    expect(priceUsageRecord(compact)).toBeNull();
    parseCodexUsageLine(turnContext('gpt-6.2-sol', 'turn-2'), state);
    expect(parseCodexUsageLine(usageRecordLine('next', counters(1, 1), undefined, 'turn-2'), state)?.model).toBe('gpt-6.2-sol');
  });

  test('keeps turn context and tier independent when cloning a partial scan', () => {
    const state = createCodexUsageState();
    parseCodexUsageLine(turnStarted('turn-1'), state);
    const copy = codexUsageFormat.cloneState(state);
    parseCodexUsageLine(turnContext('gpt-6.2-astra', 'turn-1'), state);
    parseCodexUsageLine(threadSettings('ultrafast', 'gpt-6.2-astra'), state);
    parseCodexUsageLine(turnContext('gpt-6.2-sol', 'turn-1'), copy);
    parseCodexUsageLine(threadSettings('priority', 'gpt-6.2-sol'), copy);
    const completed = '2026-10-01T05:17:49.900Z';
    const sample = usageRecordLine('response', counters(100, 10), completed);
    expect(parseCodexUsageLine(sample, state)).toMatchObject({
      model: 'gpt-6.2-astra', speed: 'ultrafast', timestampMs: Date.parse(completed),
    });
    expect(parseCodexUsageLine(sample, copy)).toMatchObject({
      model: 'gpt-6.2-sol', speed: 'fast', timestampMs: Date.parse(completed),
    });
  });

  test('attributes a response to the speed at turn start, not a selection made during inference', () => {
    const state = createCodexUsageState();
    parseCodexUsageLine(turnContext('gpt-6-sol', 'turn-1'), state);
    parseCodexUsageLine(threadSettings('priority'), state);
    parseCodexUsageLine(threadSettings('ultrafast'), state);
    expect(parseCodexUsageLine(usageRecordLine('resp_fast', counters(100, 10)), state)?.speed).toBe('fast');
    parseCodexUsageLine(turnContext('gpt-6-sol', 'turn-2'), state);
    expect(parseCodexUsageLine(usageRecordLine('resp_ultrafast', counters(120, 10), undefined, 'turn-2'), state)?.speed).toBe('ultrafast');
    const late = parseCodexUsageLine(usageRecordLine('late_response', counters(10, 3), undefined, 'turn-1'), state);
    expect(late).toMatchObject({ speed: 'unknown', totals: { outputTokens: 3 } });
  });

  test('counts an unrecognized native tier without pricing it as Standard', () => {
    const state = createCodexUsageState();
    parseCodexUsageLine(threadSettings('synthetic-unknown-tier'), state);
    parseCodexUsageLine(turnStarted('turn-1'), state);
    parseCodexUsageLine(turnContext('gpt-6-sol', 'turn-1'), state);
    const record = parseCodexUsageLine(usageRecordLine('unknown-tier', counters(100, 10)), state)!;
    expect(record).toMatchObject({ speed: 'unknown', totals: { uncachedInputTokens: 100, outputTokens: 10 } });
    expect(priceUsageRecord(record)).toBeNull();
  });

  test('attribute requests to the session and model from earlier context lines', () => {
    const state = started();
    const record = parseCodexUsageLine(tokenCount(counters(19_239, 299, { cached_input_tokens: 11_008, reasoning_output_tokens: 116 })), state);
    expect(record).toEqual({
      timestampMs: Date.parse('2026-10-01T05:17:49.919Z'),
      model: 'gpt-6-sol',
      sessionId: SESSION_ID,
      totals: { uncachedInputTokens: 19_239 - 11_008, cachedInputTokens: 11_008, cacheWriteTokens: 0, outputTokens: 299, reasoningTokens: 116 },
      cacheWrite1hTokens: 0,
      speed: 'standard',
      dedupeKey: expect.stringMatching(/^codex:/),
    });
  });

  test('give a verbatim fork copy the same request identity under its new session', () => {
    const parent = started();
    const copy = createCodexUsageState();
    parseCodexUsageLine(JSON.stringify({ type: 'session_meta', timestamp: '2026-10-02T00:00:00Z', payload: { id: 'forked-session' } }), copy);
    parseCodexUsageLine(turnContext(), copy);
    const line = tokenCount(counters(100, 10), counters(100, 10));
    const original = parseCodexUsageLine(line, parent);
    const copied = parseCodexUsageLine(line, copy);
    expect(copied?.sessionId).toBe('forked-session');
    expect(copied?.dedupeKey).toBe(original?.dedupeKey ?? 'missing');
    const next = parseCodexUsageLine(tokenCount(counters(50, 5), counters(150, 15), '2026-10-01T05:20:00.000Z'), parent);
    expect(next?.dedupeKey).not.toBe(original?.dedupeKey);
  });

  test('report a corrupt marked line as malformed and parse a line that lost its newline', () => {
    const state = started();
    expect(parseLine('{"type":"event_msg","payload":{"type":"token_count"', state)).toEqual({ malformed: true, timestampMs: null });
    const joined = tokenCount(counters(100, 10)) + JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message' } });
    expect(parseCodexUsageLine(joined, state)?.totals.outputTokens).toBe(10);
  });

  test('do not consume counters before a model is known', () => {
    const state = createCodexUsageState();
    expect(parseCodexUsageLine(tokenCount(counters(100, 10)), state)).toBeNull();
    parseCodexUsageLine(turnContext(), state);
    expect(parseCodexUsageLine(tokenCount(counters(100, 10)), state)).not.toBeNull();
  });

  test('skip a repeated request without cumulative counters', () => {
    const state = started();
    expect(parseCodexUsageLine(tokenCount(counters(100, 10)), state)).not.toBeNull();
    expect(parseCodexUsageLine(tokenCount(counters(100, 10)), state)).toBeNull();
  });

  test('bill each request once as cumulative counters advance', () => {
    const state = started();
    const first = counters(100, 20);
    expect(parseCodexUsageLine(tokenCount(first, first), state)?.totals.outputTokens).toBe(20);
    // A re-emitted snapshot is not a new request.
    expect(parseCodexUsageLine(tokenCount(first, first), state)).toBeNull();
    // A context-size report has zero request components.
    expect(parseCodexUsageLine(tokenCount({ ...counters(0, 0), total_tokens: 20_330 }, first), state)).toBeNull();
    expect(parseCodexUsageLine(tokenCount(counters(50, 5), counters(150, 25)), state)?.totals.uncachedInputTokens).toBe(50);
  });

  test('count a request whose counters do not reconcile as malformed', () => {
    const state = started();
    const first = counters(100, 20);
    parseCodexUsageLine(tokenCount(first, first), state);
    expect(parseLine(tokenCount(counters(50, 5), counters(400, 40), '2026-10-01T06:00:00.000Z'), state))
      .toEqual({ malformed: true, timestampMs: Date.parse('2026-10-01T06:00:00.000Z') });
    expect(isMalformed(tokenCount({ input_tokens: 10, output_tokens: 1, cached_input_tokens: 20 }), state)).toBe(true);
  });

  test('accept a resumed session whose counters restart at the current request', () => {
    const state = started();
    parseCodexUsageLine(tokenCount(counters(100, 20), counters(100, 20)), state);
    expect(parseCodexUsageLine(tokenCount(counters(30, 3), counters(30, 3)), state)?.totals.outputTokens).toBe(3);
  });

  test('carry the service tier from thread settings', () => {
    const state = started();
    parseCodexUsageLine(threadSettings('priority'), state);
    expect(parseCodexUsageLine(tokenCount(counters(100, 10)), state)?.speed).toBe('fast');
    parseCodexUsageLine(threadSettings('flex'), state);
    expect(parseCodexUsageLine(tokenCount(counters(200, 10)), state)?.speed).toBe('flex');
    parseCodexUsageLine(threadSettings('ultrafast'), state);
    expect(parseCodexUsageLine(tokenCount(counters(250, 10)), state)?.speed).toBe('ultrafast');
    parseCodexUsageLine(threadSettings('default'), state);
    expect(parseCodexUsageLine(tokenCount(counters(300, 10)), state)?.speed).toBe('standard');
  });

  test.each(forkOrigins)('suppresses inherited counters in a %s and bills the child delta', (_kind, meta) => {
    const state = started(sessionMeta(meta, afterFork(0)));
    const parent = counters(100, 20);
    expect(parseCodexUsageLine(tokenCount(parent, parent, afterFork(20)), state)).toBeNull();
    expect(parseCodexUsageLine(tokenCount(parent, parent, afterFork(1020)), state)).toBeNull();
    const child = parseCodexUsageLine(tokenCount(counters(40, 4), counters(140, 24), afterFork(1021)), state);
    expect(child?.totals.uncachedInputTokens).toBe(40);
  });

  test('take the session from the first meta only', () => {
    const state = started();
    parseCodexUsageLine(JSON.stringify({ type: 'session_meta', timestamp: '2026-10-01T06:00:00Z', payload: { id: 'ancestor' } }), state);
    expect(parseCodexUsageLine(tokenCount(counters(10, 1)), state)?.sessionId).toBe(SESSION_ID);
  });

  test('clone state independently for resumed reads', () => {
    const state = started();
    const first = counters(100, 20);
    parseCodexUsageLine(tokenCount(first, first), state);
    const copy = codexUsageFormat.cloneState(state);
    parseCodexUsageLine(tokenCount(counters(50, 5), counters(150, 25)), state);
    expect(copy.lastCumulativeUsage).toEqual(first);
    expect(parseCodexUsageLine(tokenCount(counters(50, 5), counters(150, 25)), copy)?.totals.uncachedInputTokens).toBe(50);
  });

  test('bill usage records, including remote compaction the context counters never show', () => {
    const state = started();
    const first = counters(1_000, 100);
    expect(parseCodexUsageLine(usageRecordLine('resp_1', first), state)).toMatchObject({
      totals: { uncachedInputTokens: 1_000, outputTokens: 100 },
      dedupeKey: 'codex-response:resp_1',
    });
    expect(parseCodexUsageLine(tokenCount(first, first), state)).toBeNull();
    // A remote compaction is billed by its record; the next snapshot is a context estimate.
    expect(parseCodexUsageLine(usageRecordLine('resp_compact', counters(5_000, 400), '2026-10-01T05:18:00.000Z'), state)?.totals.outputTokens).toBe(400);
    expect(parseCodexUsageLine(tokenCount(counters(300, 0), counters(1_300, 100), '2026-10-01T05:18:00.100Z'), state)).toBeNull();
    expect(parseCodexUsageLine(usageRecordLine('resp_2', counters(0, 0)), state)).toBeNull();
  });

  test('keep billing token_count deltas in rollouts written before usage records', () => {
    const state = started();
    const first = counters(100, 10);
    expect(parseCodexUsageLine(tokenCount(first, first), state)?.dedupeKey).toMatch(/^codex:/);
    expect(parseCodexUsageLine(tokenCount(counters(20, 2), counters(120, 12)), state)?.totals.outputTokens).toBe(2);
  });

  test('give a verbatim fork copy of a usage record the same identity', () => {
    const parent = started();
    const copy = started(sessionMeta({ id: COPY_THREAD_ID }));
    const line = usageRecordLine('resp_1', counters(100, 10));
    expect(parseCodexUsageLine(line, parent)).toMatchObject({ sessionId: SESSION_ID, dedupeKey: 'codex-response:resp_1' });
    expect(parseCodexUsageLine(line, copy)).toMatchObject({ sessionId: COPY_THREAD_ID, dedupeKey: 'codex-response:resp_1' });
  });

  test.each(forkOrigins)('counts the first child response immediately after a %s', (_kind, meta) => {
    const state = started(sessionMeta(meta, afterFork(0)));
    parseCodexUsageLine(threadSettings('priority'), state);
    const usage = counters(40, 4);
    expect(parseCodexUsageLine(usageRecordLine('fast-child', usage, afterFork(350)), state))
      .toMatchObject({ speed: 'fast', dedupeKey: 'codex-response:fast-child' });
    expect(parseCodexUsageLine(tokenCount(usage, usage), state)).toBeNull();
  });

  test('a matching child response ends copy suppression for subsequent records', () => {
    const state = startedFork({ id: COPY_THREAD_ID });
    const parent = counters(100, 10);
    const copiedRecord = usageRecordLine('resp_parent', parent, afterFork(20), 'parent-turn', PARENT_THREAD_ID);
    expect(parseCodexUsageLine(copiedRecord, state)).toBeNull();
    expect(parseCodexUsageLine(tokenCount(parent, parent, afterFork(30)), state)).toBeNull();
    const child = counters(40, 4);
    expect(parseCodexUsageLine(usageRecordLine('resp_child', child, afterFork(40), 'turn-1', COPY_THREAD_ID), state))
      .toMatchObject({ dedupeKey: 'codex-response:resp_child', totals: { uncachedInputTokens: 40 } });
    const unowned = usageRecordLine('next-response', child, afterFork(41), 'turn-2', null);
    expect(parseCodexUsageLine(unowned, state)?.dedupeKey).toBe('codex-response:next-response');
    expect(parseCodexUsageLine(tokenCount(child, child, afterFork(2030)), state)).toBeNull();
  });

  test('preserves the response id in a verbatim copy of a fork, without billing a delayed counter', () => {
    const copy = startedFork({ id: COPY_THREAD_ID });
    const usage = counters(40, 4);
    const record = usageRecordLine('original-response', usage, afterFork(2000));
    expect(parseCodexUsageLine(record, copy)?.dedupeKey).toBe('codex-response:original-response');
    expect(parseCodexUsageLine(tokenCount(usage, usage, afterFork(3100)), copy)).toBeNull();
  });

  test('does not bill a delayed token_count when its response record was skipped as a fork copy', () => {
    const copy = startedFork({ id: COPY_THREAD_ID });
    const usage = counters(40, 4);
    expect(parseCodexUsageLine(usageRecordLine('copied-response', usage, afterFork(500)), copy)).toBeNull();
    expect(parseCodexUsageLine(tokenCount(usage, usage, afterFork(2000)), copy)).toBeNull();
    expect(copy.lastCumulativeUsage).toEqual(usage);
  });

  test.each([
    ['the fork id is missing', { id: undefined, session_id: SESSION_ID }, SESSION_ID],
    ['the fork id is malformed', { id: 'not-a-thread-id', session_id: SESSION_ID }, 'not-a-thread-id'],
    ['the response has no thread id', {}, null],
  ] as const)('falls back to timing when %s', (_case, meta, threadId) => {
    const state = startedFork(meta);
    const usage = counters(40, 4);
    const firstCopy = usageRecordLine('first-copy', usage, afterFork(999), 'turn-1', threadId);
    const nextCopy = usageRecordLine('next-copy', usage, afterFork(1998), 'turn-1', threadId);
    const child = usageRecordLine('child', usage, afterFork(2998), 'turn-2', threadId);
    expect(parseCodexUsageLine(firstCopy, state)).toBeNull();
    expect(parseCodexUsageLine(nextCopy, state)).toBeNull();
    expect(parseCodexUsageLine(child, state)?.dedupeKey).toBe('codex-response:child');
  });

  test('count a usage record without a response, usage, or model as malformed', () => {
    const at = Date.parse('2026-10-01T05:17:49.900Z');
    expect(parseLine(usageRecordLine(null, counters(1, 1)), started())).toEqual({ malformed: true, timestampMs: at });
    expect(parseLine(usageRecordLine('resp_1', { input_tokens: 1 }), started())).toEqual({ malformed: true, timestampMs: at });
    expect(parseLine(usageRecordLine('resp_1', counters(1, 1)), createCodexUsageState())).toEqual({ malformed: true, timestampMs: at });
  });
});
