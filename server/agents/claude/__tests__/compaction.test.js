import { describe, it, expect } from 'bun:test';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import {
  parseCompactMetadata,
  extractCompactionSummary,
  isCompactionSummaryText,
  COMPACT_SUMMARY_PREAMBLE,
} from '../compaction.js';
import { loadClaudeChatMessages } from '../history-loader.js';

describe('compaction helpers', () => {
  it('parses trigger and token counts from live snake_case metadata', () => {
    expect(parseCompactMetadata({ trigger: 'manual', pre_tokens: 29611, post_tokens: 3903 })).toEqual({
      trigger: 'manual',
      preTokens: 29611,
      postTokens: 3903,
    });
  });

  it('parses token counts from on-disk camelCase metadata', () => {
    expect(parseCompactMetadata({ trigger: 'manual', preTokens: 43201, postTokens: 8223 })).toEqual({
      trigger: 'manual',
      preTokens: 43201,
      postTokens: 8223,
    });
  });

  it('treats an auto trigger explicitly and defaults others to manual', () => {
    expect(parseCompactMetadata({ trigger: 'auto' }).trigger).toBe('auto');
    expect(parseCompactMetadata({ trigger: 'whatever' }).trigger).toBe('manual');
    expect(parseCompactMetadata(undefined).trigger).toBe('manual');
  });

  it('omits token counts that are not numbers', () => {
    const info = parseCompactMetadata({ trigger: 'manual', pre_tokens: 'x' });
    expect(info.preTokens).toBeUndefined();
    expect(info.postTokens).toBeUndefined();
  });

  it('extracts the summary body after the Summary marker', () => {
    const text = `${COMPACT_SUMMARY_PREAMBLE} ...\n\nSummary:\n1. Did a thing`;
    expect(extractCompactionSummary(text)).toBe('1. Did a thing');
  });

  it('falls back to the full text when no Summary marker is present', () => {
    expect(extractCompactionSummary('just a body')).toBe('just a body');
  });

  it('recognizes the continuation preamble', () => {
    expect(isCompactionSummaryText(`${COMPACT_SUMMARY_PREAMBLE} that ran out of context.`)).toBe(true);
    expect(isCompactionSummaryText('a normal user message')).toBe(false);
  });
});

async function withTempJsonl(lines, fn) {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-compact-test-'));
  const filePath = path.join(tmpDir, 'session.jsonl');
  await fs.writeFile(filePath, `${lines.join('\n')}\n`, 'utf8');
  try {
    return await fn(filePath);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

describe('loadClaudeChatMessages compaction boundary', () => {
  it('folds a compact_boundary and summary into a single CompactionMessage', async () => {
    const sessionId = 'session-compact';
    const lines = [
      JSON.stringify({
        sessionId,
        type: 'user',
        timestamp: '2026-02-21T10:00:00.000Z',
        message: { role: 'user', content: 'design a todo app' },
      }),
      JSON.stringify({
        sessionId,
        type: 'assistant',
        timestamp: '2026-02-21T10:00:01.000Z',
        message: { role: 'assistant', content: [{ type: 'text', text: 'sure' }] },
      }),
      JSON.stringify({
        sessionId,
        type: 'system',
        subtype: 'compact_boundary',
        // The boundary timestamp is slightly later than the summary's, as seen on
        // disk, so the chronological sort places the summary first.
        timestamp: '2026-02-21T10:00:02.013Z',
        // On-disk history uses camelCase metadata, unlike the live snake_case stream.
        compactMetadata: { trigger: 'manual', preTokens: 29611, postTokens: 3903 },
      }),
      JSON.stringify({
        sessionId,
        type: 'user',
        isCompactSummary: true,
        timestamp: '2026-02-21T10:00:02.009Z',
        message: {
          role: 'user',
          content: 'This session is being continued from a previous conversation. Summary:\n1. Built a todo app',
        },
      }),
    ];

    const messages = await withTempJsonl(lines, (filePath) => loadClaudeChatMessages(filePath));
    const compaction = messages.find((message) => message.type === 'compaction');

    expect(compaction).toBeDefined();
    expect(compaction.trigger).toBe('manual');
    expect(compaction.preTokens).toBe(29611);
    expect(compaction.postTokens).toBe(3903);
    expect(compaction.summary).toBe('1. Built a todo app');
    // The summary is not also emitted as a plain user message.
    expect(messages.filter((m) => m.type === 'user-message' && m.content.startsWith('This session'))).toHaveLength(0);
  });
});
