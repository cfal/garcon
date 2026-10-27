import { describe, expect, test } from 'bun:test';
import { claudeUsageFormat, parseClaudeUsageLine } from '../usage-format.js';

function assistantLine(overrides: {
  messageId?: string;
  requestId?: string;
  model?: string;
  contentType?: string;
  usage?: Record<string, unknown>;
}): string {
  return JSON.stringify({
    type: 'assistant',
    timestamp: '2026-10-07T04:05:13.944Z',
    sessionId: '00000000-0000-4000-8000-000000000001',
    requestId: overrides.requestId ?? 'req_synthetic',
    cwd: '/workspace/sample',
    message: {
      id: overrides.messageId ?? 'msg_synthetic',
      role: 'assistant',
      model: overrides.model ?? 'claude-opus-5-5',
      content: [{ type: overrides.contentType ?? 'text', text: 'Sample response.' }],
      usage: overrides.usage ?? {
        input_tokens: 2,
        cache_creation_input_tokens: 6_000,
        cache_read_input_tokens: 1_000,
        output_tokens: 286,
        cache_creation: { ephemeral_5m_input_tokens: 2_000, ephemeral_1h_input_tokens: 4_000 },
      },
    },
  });
}

describe('Claude usage lines', () => {
  test('extract token totals, one-hour cache writes, and a dedupe key', () => {
    expect(parseClaudeUsageLine(assistantLine({}))).toEqual({
      timestampMs: Date.parse('2026-10-07T04:05:13.944Z'),
      model: 'claude-opus-5-5',
      sessionId: '00000000-0000-4000-8000-000000000001',
      totals: { uncachedInputTokens: 2, cachedInputTokens: 1_000, cacheWriteTokens: 6_000, outputTokens: 286, reasoningTokens: 0 },
      cacheWrite1hTokens: 4_000,
      speed: 'standard',
      dedupeKey: 'msg_synthetic:req_synthetic',
    });
  });

  test('give every content block of one message the same key', () => {
    const text = parseClaudeUsageLine(assistantLine({ contentType: 'text' }));
    const toolUse = parseClaudeUsageLine(assistantLine({ contentType: 'tool_use' }));
    expect(text?.dedupeKey).toBe(toolUse?.dedupeKey);
    expect(text?.totals).toEqual(toolUse?.totals);
  });

  test('mark fast-mode requests', () => {
    expect(parseClaudeUsageLine(assistantLine({ usage: { input_tokens: 1, output_tokens: 1, speed: 'fast' } }))?.speed).toBe('fast');
  });

  test('skip local placeholders, non-assistant lines, and lines without usage or time', () => {
    expect(parseClaudeUsageLine(assistantLine({ model: '<synthetic>' }))).toBeNull();
    expect(parseClaudeUsageLine(JSON.stringify({ type: 'user', timestamp: '2026-10-07T00:00:00Z', message: { usage: {} } }))).toBeNull();
    expect(parseClaudeUsageLine(JSON.stringify({ type: 'assistant', timestamp: '2026-10-07T00:00:00Z', message: { model: 'claude-opus-5-5' } }))).toBeNull();
    expect(parseClaudeUsageLine(JSON.stringify({ type: 'assistant', message: { model: 'claude-opus-5-5', usage: {} } }))).toBeNull();
    expect(parseClaudeUsageLine('{not json')).toBeNull();
  });

  test('keep real zero-token responses and ignore invalid counts', () => {
    const record = parseClaudeUsageLine(assistantLine({ usage: { input_tokens: 0, output_tokens: -4, cache_read_input_tokens: 'many' } }));
    expect(record?.totals).toEqual({ uncachedInputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 0, reasoningTokens: 0 });
  });

  test('gate lines on the usage marker the format declares', () => {
    expect(claudeUsageFormat.lineMarkers.every((marker) => assistantLine({}).includes(marker))).toBe(true);
  });
});
