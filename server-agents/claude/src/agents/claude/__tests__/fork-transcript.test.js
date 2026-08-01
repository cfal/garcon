import { describe, expect, it } from 'bun:test';
import crypto from 'node:crypto';
import {
  createClaudeForkTranscriptTransformer,
  projectClaudeForkEntry,
  transformClaudeForkTranscript,
} from '../fork-transcript.js';
import { convertClaudeEntries } from '../history-loader.js';

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
  const taskActivationShapes = [
    [
      'an explicitly backgrounded shell',
      {
        backgroundTaskId: 'task-explicit',
        stdout: 'Command running in background.',
        stderr: '',
        interrupted: false,
        isImage: false,
        noOutputExpected: false,
      },
    ],
    [
      'an auto-backgrounded shell',
      {
        backgroundTaskId: 'task-timeout',
        stdout: 'Command timed out and continues in background.',
        stderr: '',
        interrupted: false,
        isImage: false,
        noOutputExpected: false,
        timedOutAfterMs: 120_000,
        backgroundCwdHint: '/repo',
      },
    ],
    [
      'a background shell with persisted output',
      {
        backgroundTaskId: 'task-persisted',
        stdout: 'Output is available on disk.',
        stderr: '',
        interrupted: false,
        isImage: false,
        noOutputExpected: false,
        outputFilePath: '/tmp/task-persisted.output',
        outputFileSize: 4096,
        outputTaskId: 'task-output',
      },
    ],
  ];

  it.each(taskActivationShapes)(
    'strips source task identity from %s without changing rendered output',
    (_name, toolUseResult) => {
      const sourceEntries = [{
        type: 'user',
        uuid: 'source-result',
        parentUuid: null,
        sessionId: context.sourceAgentSessionId,
        timestamp: '2026-07-30T00:00:00.000Z',
        message: {
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: 'tool-background',
            content: 'Command running in background.',
          }],
        },
        toolUseResult,
      }];
      const original = structuredClone(sourceEntries);

      const result = transformClaudeForkTranscript({
        selectedEntries: sourceEntries,
        sourceEntries,
        ...context,
      });
      const copied = result.entries[0];
      const expectedToolUseResult = withoutTaskActivationFields(toolUseResult);

      expect(copied.toolUseResult).toEqual(expectedToolUseResult);
      expect(copied.toolUseResult).not.toBe(sourceEntries[0].toolUseResult);
      expect(sourceEntries).toEqual(original);
      expect(convertClaudeEntries([copied])).toEqual(
        renderedWithoutTaskActivation(original, copied.timestamp),
      );
    },
  );

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

  it('copies microcompaction re-appends faithfully instead of refusing the duplicate uuids', () => {
    const transform = createClaudeForkTranscriptTransformer({
      now: () => '2026-07-29T00:00:00.000Z',
    });
    const base = {
      sessionId: context.sourceAgentSessionId,
      isSidechain: false,
    };
    const selectedEntries = [
      {
        ...base, type: 'user', uuid: 'src-user', parentUuid: null,
        timestamp: '2026-07-29T00:34:08.457Z', message: { role: 'user', content: 'run the build' },
      },
      {
        ...base, type: 'assistant', uuid: 'src-assistant', parentUuid: 'src-user',
        timestamp: '2026-07-29T00:34:09.000Z',
        message: { role: 'assistant', content: [{ type: 'text', text: 'building' }] },
      },
      {
        ...base, type: 'user', uuid: 'src-user', parentUuid: 'src-assistant',
        timestamp: '2026-07-29T00:34:08.457Z', message: { role: 'user', content: 'run the build' },
      },
      {
        ...base, type: 'assistant', uuid: 'src-assistant', parentUuid: 'src-user',
        timestamp: '2026-07-29T00:34:09.000Z',
        message: { role: 'assistant', content: [{ type: 'text', text: 'building' }] },
      },
      {
        ...base, type: 'system', subtype: 'compact_boundary', uuid: 'src-boundary',
        parentUuid: 'src-assistant', timestamp: '2026-07-29T07:27:07.261Z',
        compactMetadata: { trigger: 'auto', pre_tokens: 200000 },
      },
      {
        ...base, type: 'user', uuid: 'src-summary', parentUuid: 'src-assistant',
        isCompactSummary: true, timestamp: '2026-07-29T07:27:07.259Z',
        message: { role: 'user', content: 'summary of the build conversation' },
      },
      {
        ...base, type: 'assistant', uuid: 'src-after', parentUuid: 'src-summary',
        timestamp: '2026-07-29T07:28:00.000Z',
        message: { role: 'assistant', content: [{ type: 'text', text: 'continuing' }] },
      },
    ];

    const result = transform({
      selectedEntries,
      sourceEntries: selectedEntries,
      ...context,
    });

    const emitted = result.entries.filter((entry) => entry.type !== 'content-replacement');
    expect(emitted).toHaveLength(7);
    const countsByUuid = new Map();
    for (const entry of emitted) {
      countsByUuid.set(entry.uuid, (countsByUuid.get(entry.uuid) ?? 0) + 1);
    }
    expect([...countsByUuid.values()].sort()).toEqual([1, 1, 1, 2, 2]);
    for (const entry of emitted) {
      expect(entry.uuid).not.toStartWith('src-');
      expect(entry.sessionId).toBe(context.targetAgentSessionId);
    }
    const forkedUser = emitted[0];
    const forkedSummary = emitted[5];
    expect(emitted[2].uuid).toBe(forkedUser.uuid);
    expect(emitted[2].parentUuid).toBe(emitted[1].uuid);
    expect(forkedSummary.parentUuid).toBe(emitted[1].uuid);
    expect(result.expectedSemanticDigest).toStartWith('ordered-v1:');
  });

  it('remaps a retained parent that appears later in physical file order', () => {
    const sourceEntries = [
      {
        type: 'user', uuid: 'source-root', parentUuid: null,
        sessionId: context.sourceAgentSessionId, timestamp: '2026-08-01T02:43:12.000Z',
        message: { role: 'user', content: 'Inspect the repository.' },
      },
      {
        type: 'attachment', uuid: 'source-hook-success', parentUuid: 'source-hook-error',
        sessionId: context.sourceAgentSessionId, timestamp: '2026-08-01T02:43:12.324Z',
        attachment: { type: 'hook_success' },
      },
      {
        type: 'attachment', uuid: 'source-hook-error', parentUuid: 'source-root',
        sessionId: context.sourceAgentSessionId, timestamp: '2026-08-01T02:43:12.262Z',
        attachment: { type: 'hook_non_blocking_error' },
      },
      {
        type: 'assistant', uuid: 'source-leaf', parentUuid: 'source-hook-success',
        sessionId: context.sourceAgentSessionId, timestamp: '2026-08-01T02:43:13.000Z',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] },
      },
    ];

    const result = transformClaudeForkTranscript({
      selectedEntries: sourceEntries,
      sourceEntries,
      ...context,
    });
    const entriesBySourceUuid = new Map(result.entries.map((entry) => [
      entry.forkedFrom?.messageUuid,
      entry,
    ]));
    const hookSuccess = entriesBySourceUuid.get('source-hook-success');
    const hookError = entriesBySourceUuid.get('source-hook-error');
    expect(hookSuccess).toBeDefined();
    expect(hookError).toBeDefined();
    expect(result.entries.indexOf(hookSuccess)).toBeLessThan(result.entries.indexOf(hookError));
    expect(hookSuccess.parentUuid).toBe(hookError.uuid);

    const targetUuids = new Set(result.entries.map((entry) => entry.uuid));
    const sourceUuids = new Set(sourceEntries.map((entry) => entry.uuid));
    for (const entry of result.entries) {
      expect(entry.sessionId).toBe(context.targetAgentSessionId);
      expect(sourceUuids.has(entry.uuid)).toBe(false);
      if (entry.parentUuid !== null) expect(targetUuids.has(entry.parentUuid)).toBe(true);
    }
    expect(result.expectedSemanticDigest).toStartWith('ordered-v1:');
  });
});

function withoutTaskActivationFields(toolUseResult) {
  const projected = structuredClone(toolUseResult);
  delete projected.backgroundTaskId;
  delete projected.outputTaskId;
  return projected;
}

function renderedWithoutTaskActivation(entries, forkTimestamp) {
  const projected = structuredClone(entries);
  projected[projected.length - 1].timestamp = forkTimestamp;
  const rendered = convertClaudeEntries(projected);
  for (const message of rendered) {
    const toolUseResult = message.content?.toolUseResult;
    if (typeof toolUseResult !== 'object' || toolUseResult === null) continue;
    delete toolUseResult.backgroundTaskId;
    delete toolUseResult.outputTaskId;
  }
  return rendered;
}
