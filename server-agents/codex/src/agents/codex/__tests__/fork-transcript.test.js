import { describe, expect, it } from 'bun:test';
import {
  createCodexForkTranscriptRewriter,
  rewriteCodexForkTranscriptEntry,
} from '../fork-transcript.js';

const context = {
  sourceAgentSessionId: '11111111-1111-1111-1111-111111111111',
  targetAgentSessionId: '22222222-2222-2222-2222-222222222222',
};

describe('rewriteCodexForkTranscriptEntry', () => {
  it('rewrites the thread identity in the Codex session metadata payload', () => {
    const entry = {
      timestamp: '2026-07-15T10:00:00.000Z',
      type: 'session_meta',
      payload: {
        session_id: context.sourceAgentSessionId,
        id: context.sourceAgentSessionId,
        cwd: '/repo',
        forked_from_id: 'parent-thread',
        parent_thread_id: 'parent-agent-thread',
      },
    };

    expect(rewriteCodexForkTranscriptEntry(entry, context)).toEqual({
      timestamp: '2026-07-15T10:00:00.000Z',
      type: 'session_meta',
      payload: {
        session_id: context.targetAgentSessionId,
        id: context.targetAgentSessionId,
        cwd: '/repo',
        forked_from_id: 'parent-thread',
        parent_thread_id: 'parent-agent-thread',
      },
    });
    expect(entry.payload.id).toBe(context.sourceAgentSessionId);
    expect(entry.payload.session_id).toBe(context.sourceAgentSessionId);
  });

  it('preserves non-session metadata and unmatched identities', () => {
    const message = {
      type: 'event_msg',
      payload: { type: 'user_message', message: context.sourceAgentSessionId },
    };
    const otherThread = {
      type: 'session_meta',
      payload: { id: 'another-thread' },
    };

    expect(rewriteCodexForkTranscriptEntry(message, context)).toBe(message);
    expect(rewriteCodexForkTranscriptEntry(otherThread, context)).toBe(otherThread);
  });

  it('rewrites legacy metadata without adding a session_id field', () => {
    const entry = {
      type: 'session_meta',
      payload: {
        id: context.sourceAgentSessionId,
        cwd: '/repo',
      },
    };

    const rewritten = rewriteCodexForkTranscriptEntry(entry, context);
    expect(rewritten).toEqual({
      type: 'session_meta',
      payload: {
        id: context.targetAgentSessionId,
        cwd: '/repo',
      },
    });
    expect(rewritten.payload).not.toHaveProperty('session_id');
  });

  it('truncates a completed web search entry before its synthetic result', () => {
    const entry = {
      type: 'response_item',
      timestamp: '2026-07-18T10:00:00.000Z',
      payload: {
        type: 'web_search_call',
        id: 'search-1',
        status: 'completed',
        action: { type: 'search', query: 'Garcon' },
      },
    };
    expect(rewriteCodexForkTranscriptEntry(entry, {
      ...context,
      retainedMessageCount: 1,
    })).toEqual({
      ...entry,
      payload: { ...entry.payload, status: 'in_progress' },
    });
  });

  it('neutralizes an unselected fallback entry before the physical cutoff', () => {
    const entry = {
      type: 'event_msg',
      timestamp: '2026-07-18T10:00:00.000Z',
      payload: { type: 'user_message', message: 'not selected' },
    };
    expect(rewriteCodexForkTranscriptEntry(entry, {
      ...context,
      retainedMessageCount: 0,
    })).toEqual({ type: 'garcon_fork_filtered' });
  });

  it('counts Code Mode Exec envelopes and their paired outputs as rendered messages', () => {
    const rewrite = createCodexForkTranscriptRewriter();
    const exec = {
      type: 'response_item',
      payload: { type: 'custom_tool_call', name: 'exec', call_id: 'outer', input: 'text("ok")' },
    };
    const output = {
      type: 'response_item',
      payload: { type: 'custom_tool_call_output', call_id: 'outer', output: 'done' },
    };

    expect(rewrite(exec, { ...context, retainedMessageCount: 0 }))
      .toEqual({ type: 'garcon_fork_filtered' });
    expect(rewrite(output, { ...context, retainedMessageCount: 0 }))
      .toEqual({ type: 'garcon_fork_filtered' });

    const selectedRewrite = createCodexForkTranscriptRewriter();
    expect(selectedRewrite(exec, { ...context, retainedMessageCount: 1 })).toBe(exec);
    expect(selectedRewrite(output, { ...context, retainedMessageCount: 1 })).toBe(output);
  });

  it('preserves provider records that the shared legacy projection does not render', () => {
    const entry = {
      type: 'response_item',
      payload: {
        type: 'agent_message',
        id: 'provider-only',
        content: [{ type: 'output_text', text: 'ordinary provider state' }],
      },
    };

    expect(createCodexForkTranscriptRewriter()(entry, {
      ...context,
      retainedMessageCount: 0,
    })).toBe(entry);
  });
});
