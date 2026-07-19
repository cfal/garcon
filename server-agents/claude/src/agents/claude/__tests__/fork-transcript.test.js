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
});
