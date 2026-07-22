import { describe, expect, it } from 'bun:test';
import crypto from 'node:crypto';
import {
  createClaudeForkTranscriptTransformer,
  projectClaudeForkEntry,
} from '../fork-transcript.js';

const context = {
  sourceAgentSessionId: '11111111-1111-1111-1111-111111111111',
  targetAgentSessionId: '22222222-2222-2222-2222-222222222222',
};

describe('projectClaudeForkEntry', () => {
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

    expect(projectClaudeForkEntry(entry, {
      ...context,
      retainedMessageCount: 2,
    })).toEqual({
      ...entry,
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

    const projected = projectClaudeForkEntry(entry, {
      ...context,
      retainedMessageCount: 1,
    });
    expect(projected.message.content).toEqual([entry.message.content[0]]);
  });

  it('marks an unselected provider entry as provider-native metadata', () => {
    const entry = {
      sessionId: context.sourceAgentSessionId,
      type: 'user',
      message: { role: 'user', content: 'not selected' },
    };
    expect(projectClaudeForkEntry(entry, {
      ...context,
      retainedMessageCount: 0,
    })).toEqual({ ...entry, isMeta: true });
  });
});

describe('transformClaudeForkTranscript', () => {
  it('creates an independent graph and preserves provider replacement metadata', () => {
    const uuids = [
      '10000000-0000-4000-8000-000000000001',
      '10000000-0000-4000-8000-000000000002',
      '10000000-0000-4000-8000-000000000003',
      '10000000-0000-4000-8000-000000000004',
    ];
    const transform = createClaudeForkTranscriptTransformer({
      randomUUID: () => uuids.shift(),
      now: () => '2026-07-21T00:00:00.000Z',
    });
    const sourceEntries = [
      {
        type: 'user', uuid: 'source-user', parentUuid: null,
        sessionId: context.sourceAgentSessionId, session_id: context.sourceAgentSessionId,
        timestamp: '2026-07-20T00:00:00.000Z', isSidechain: false,
        teamName: 'source-team', message: { role: 'user', content: 'hello' },
      },
      {
        type: 'progress', uuid: 'source-progress', parentUuid: 'source-user',
        sessionId: context.sourceAgentSessionId, timestamp: '2026-07-20T00:00:01.000Z',
      },
      {
        type: 'assistant', uuid: 'source-assistant', parentUuid: 'source-progress',
        logicalParentUuid: 'source-user', sessionId: context.sourceAgentSessionId,
        timestamp: '2026-07-20T00:00:02.000Z', agentName: 'source-agent',
        message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
      },
      {
        type: 'assistant', uuid: 'source-sidechain', parentUuid: 'source-user',
        sessionId: context.sourceAgentSessionId, isSidechain: true,
        message: { role: 'assistant', content: [{ type: 'text', text: 'hidden' }] },
      },
      {
        type: 'content-replacement', uuid: 'source-replacement',
        sessionId: context.sourceAgentSessionId,
        replacements: [{ old: 'secret', new: 'redacted', messageUuid: 'source-user' }],
      },
    ];
    const original = structuredClone(sourceEntries);

    const result = transform({
      selectedEntries: sourceEntries,
      sourceEntries,
      ...context,
    });

    expect(result.entries).toEqual([
      expect.objectContaining({
        type: 'user', uuid: '10000000-0000-4000-8000-000000000001', parentUuid: null,
        sessionId: context.targetAgentSessionId, session_id: context.targetAgentSessionId,
        forkedFrom: { sessionId: context.sourceAgentSessionId, messageUuid: 'source-user' },
      }),
      expect.objectContaining({
        type: 'assistant', uuid: '10000000-0000-4000-8000-000000000003',
        parentUuid: '10000000-0000-4000-8000-000000000001',
        logicalParentUuid: '10000000-0000-4000-8000-000000000001',
        timestamp: '2026-07-21T00:00:00.000Z',
      }),
      {
        type: 'content-replacement',
        uuid: '10000000-0000-4000-8000-000000000004',
        timestamp: '2026-07-21T00:00:00.000Z',
        sessionId: context.targetAgentSessionId,
        replacements: [{ old: 'secret', new: 'redacted', messageUuid: 'source-user' }],
      },
    ]);
    expect(result.entries[0]).not.toHaveProperty('teamName');
    expect(result.entries[1]).not.toHaveProperty('agentName');
    expect(result.expectedSemanticDigest).toStartWith('ordered-v1:2:');
    expect(sourceEntries).toEqual(original);
  });

  it('rejects a child whose retained parent appears later in the file', () => {
    const transform = createClaudeForkTranscriptTransformer({ randomUUID: crypto.randomUUID });
    expect(() => transform({
      selectedEntries: [
        { type: 'assistant', uuid: 'child', parentUuid: 'parent', sessionId: context.sourceAgentSessionId },
        { type: 'user', uuid: 'parent', parentUuid: null, sessionId: context.sourceAgentSessionId },
      ],
      sourceEntries: [],
      ...context,
    })).toThrow('parent appears after its child');
  });
});
