import { describe, expect, it } from 'bun:test';
import { rewriteClaudeForkTranscriptEntry } from '../fork-transcript.js';

const context = {
  sourceAgentSessionId: '11111111-1111-1111-1111-111111111111',
  targetAgentSessionId: '22222222-2222-2222-2222-222222222222',
};

describe('rewriteClaudeForkTranscriptEntry', () => {
  it('rewrites only matching top-level Claude session identity fields', () => {
    const entry = {
      sessionId: context.sourceAgentSessionId,
      session_id: context.sourceAgentSessionId,
      content: context.sourceAgentSessionId,
      message: { sessionId: context.sourceAgentSessionId },
    };

    expect(rewriteClaudeForkTranscriptEntry(entry, context)).toEqual({
      sessionId: context.targetAgentSessionId,
      session_id: context.targetAgentSessionId,
      content: context.sourceAgentSessionId,
      message: { sessionId: context.sourceAgentSessionId },
    });
    expect(entry.sessionId).toBe(context.sourceAgentSessionId);
  });

  it('preserves entries without the source session identity', () => {
    const entry = { sessionId: 'another-session', content: 'unchanged' };
    expect(rewriteClaudeForkTranscriptEntry(entry, context)).toBe(entry);
  });

  it('truncates a multi-message assistant entry at the exact canonical prefix', () => {
    const entry = {
      sessionId: context.sourceAgentSessionId,
      type: 'assistant',
      timestamp: '2026-07-18T10:00:00.000Z',
      message: {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'inspect' },
          { type: 'text', text: 'first answer' },
          { type: 'tool_use', id: 'tool-1', name: 'Read', input: { file_path: '/repo/a.ts' } },
        ],
      },
    };

    expect(rewriteClaudeForkTranscriptEntry(entry, {
      ...context,
      retainedMessageCount: 2,
    })).toEqual({
      ...entry,
      sessionId: context.targetAgentSessionId,
      message: {
        ...entry.message,
        content: entry.message.content.slice(0, 2),
      },
    });
  });

  it('retains only selected tool results before an aggregate user message', () => {
    const entry = {
      sessionId: context.sourceAgentSessionId,
      type: 'user',
      timestamp: '2026-07-18T10:00:00.000Z',
      message: {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'tool-1', content: 'done' },
          { type: 'text', text: 'follow up' },
        ],
      },
    };

    const rewritten = rewriteClaudeForkTranscriptEntry(entry, {
      ...context,
      retainedMessageCount: 1,
    });
    expect(rewritten.message.content).toEqual([entry.message.content[0]]);
  });

  it('marks an unselected provider entry as provider-native metadata', () => {
    const entry = {
      sessionId: context.sourceAgentSessionId,
      type: 'user',
      message: { role: 'user', content: 'not selected' },
    };
    expect(rewriteClaudeForkTranscriptEntry(entry, {
      ...context,
      retainedMessageCount: 0,
    })).toEqual({
      sessionId: context.targetAgentSessionId,
      type: 'user',
      message: { role: 'user', content: 'not selected' },
      isMeta: true,
    });
  });
});
