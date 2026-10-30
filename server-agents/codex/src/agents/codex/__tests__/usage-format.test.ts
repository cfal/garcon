import { describe, expect, test } from 'bun:test';
import { isMalformedUsage, type UsageRecord } from '@garcon/server-agent-common/usage/usage-record';
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

const SESSION_ID = '00000000-0000-4000-8000-0000000000c1';
const sessionMeta = (payload: Record<string, unknown> = {}, timestamp = '2026-10-01T05:17:41.289Z') =>
  JSON.stringify({ type: 'session_meta', timestamp, payload: { id: SESSION_ID, ...payload } });
const turnContext = (model = 'gpt-6-sol') =>
  JSON.stringify({ type: 'turn_context', timestamp: '2026-10-01T05:17:42.694Z', payload: { model } });
const threadSettings = (serviceTier: string) =>
  JSON.stringify({ type: 'event_msg', timestamp: '2026-10-01T05:17:43.000Z', payload: { type: 'thread_settings_applied', thread_settings: { model: 'gpt-6-sol', service_tier: serviceTier } } });

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

// Mirrors the pinned 0.164.0 rollout line written for each billed response.
function usageRecordLine(responseId: unknown, usage: unknown, timestamp = '2026-10-01T05:17:49.900Z'): string {
  return JSON.stringify({
    type: 'token_usage_record',
    timestamp,
    payload: { thread_id: SESSION_ID, turn_id: 'turn-1', session_id: SESSION_ID, root_turn_id: 'turn-1', response_id: responseId, usage },
  });
}

function started(): CodexUsageState {
  const state = createCodexUsageState();
  parseCodexUsageLine(sessionMeta(), state);
  parseCodexUsageLine(turnContext(), state);
  return state;
}

describe('Codex usage lines', () => {
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
    parseCodexUsageLine(threadSettings('default'), state);
    expect(parseCodexUsageLine(tokenCount(counters(300, 10)), state)?.speed).toBe('standard');
  });

  test('suppress the copied parent history at the start of a fork', () => {
    const state = createCodexUsageState();
    parseCodexUsageLine(sessionMeta({ forked_from_id: '00000000-0000-4000-8000-0000000000c0' }, '2026-10-01T05:00:00.000Z'), state);
    parseCodexUsageLine(turnContext(), state);
    const parent = counters(100, 20);
    expect(parseCodexUsageLine(tokenCount(parent, parent, '2026-10-01T05:00:00.020Z'), state)).toBeNull();
    // Genuine child usage arrives after a model turn and extends the copied baseline.
    const child = parseCodexUsageLine(tokenCount(counters(40, 4), counters(140, 24), '2026-10-01T05:00:09.000Z'), state);
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
    const copy = createCodexUsageState();
    parseCodexUsageLine(sessionMeta({}, '2026-10-02T00:00:00Z'), copy);
    parseCodexUsageLine(turnContext(), copy);
    const line = usageRecordLine('resp_1', counters(100, 10));
    expect(parseCodexUsageLine(line, copy)?.dedupeKey).toBe(parseCodexUsageLine(line, parent)?.dedupeKey ?? 'missing');
  });

  test('skip restamped usage records copied into a native fork', () => {
    const state = createCodexUsageState();
    parseCodexUsageLine(sessionMeta({ forked_from_id: '00000000-0000-4000-8000-0000000000c0' }, '2026-10-01T05:00:00.000Z'), state);
    parseCodexUsageLine(turnContext(), state);
    expect(parseCodexUsageLine(usageRecordLine('resp_parent', counters(100, 10), '2026-10-01T05:00:00.010Z'), state)).toBeNull();
    expect(parseCodexUsageLine(tokenCount(counters(100, 10), counters(100, 10), '2026-10-01T05:00:00.020Z'), state)).toBeNull();
    const child = parseCodexUsageLine(usageRecordLine('resp_child', counters(40, 4), '2026-10-01T05:00:09.000Z'), state);
    expect(child?.dedupeKey).toBe('codex-response:resp_child');
    expect(parseCodexUsageLine(tokenCount(counters(40, 4), counters(140, 14), '2026-10-01T05:00:09.100Z'), state)).toBeNull();
  });

  test('count a usage record without a response, usage, or model as malformed', () => {
    const at = Date.parse('2026-10-01T05:17:49.900Z');
    expect(parseLine(usageRecordLine(null, counters(1, 1)), started())).toEqual({ malformed: true, timestampMs: at });
    expect(parseLine(usageRecordLine('resp_1', { input_tokens: 1 }), started())).toEqual({ malformed: true, timestampMs: at });
    expect(parseLine(usageRecordLine('resp_1', counters(1, 1)), createCodexUsageState())).toEqual({ malformed: true, timestampMs: at });
  });
});
