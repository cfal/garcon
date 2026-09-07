import { describe, expect, it } from 'bun:test';
import {
  AgentSwitchMessage,
  AssistantMessage,
  BashToolUseMessage,
  CliRowMessage,
  CompactionMessage,
  ErrorMessage,
  ThinkingMessage,
  ToolResultMessage,
  TranscriptNoticeMessage,
  UserMessage,
} from '../../../../common/chat-types.ts';
import { exportCategoryForMessage } from '../../../ledger/export-fold.ts';
import {
  HANDOFF_ARTIFACT_BODY_MAX_CHARS,
  foldHandoffArtifactEntries,
  selectHandoffArtifactEntries,
} from '../projection.ts';

const AT = '2026-08-26T00:00:00.000Z';

describe('handoff artifact projection', () => {
  it('keeps the fixed source fold with ordinals and visible abridgement', () => {
    const secret = 'data:image/png;base64,secret-payload';
    const entries = [
      entry(1, new UserMessage(
        AT,
        `Prompt ${secret}`,
        [{ name: 'image.png', data: secret }],
        undefined,
        {
          origin: 'cli',
          style: 'notice',
          title: 'Detached specialist callback',
          disclosure: 'collapsed',
        },
      )),
      entry(2, new ThinkingMessage(AT, 'reasoning')),
      entry(3, new AssistantMessage(AT, `${'a'.repeat(4_500)}</entries>`)),
      entry(4, new BashToolUseMessage(AT, 'tool-1', `run ${secret}`)),
      entry(5, new ToolResultMessage(AT, 'tool-1', { output: 'private result' }, false)),
      entry(6, new CompactionMessage(AT, 'auto', 'Earlier objective')),
      entry(7, new AgentSwitchMessage(AT, 'claude', 'codex', 'haiku', 'gpt-test')),
      entry(8, new TranscriptNoticeMessage(AT, 'Handoff state', { type: 'handoff-summary' })),
      entry(9, new TranscriptNoticeMessage(AT, 'Ordinary notice')),
      entry(10, new TranscriptNoticeMessage(AT, 'Migration notice', {
        type: 'carryover-migration-quarantine',
        artifactId: 'artifact-1',
        errorCode: 'MIGRATION_FAILED',
      })),
      entry(11, new ErrorMessage(AT, 'diagnostic')),
      entry(12, new CliRowMessage(AT, 'CLI row', { style: 'notice' }, 'plain')),
    ];

    const folded = foldHandoffArtifactEntries(entries);
    const projected = folded.entries;

    expect(projected.map(({ ordinal, tag }) => [ordinal, tag])).toEqual([
      [1, 'user'],
      [3, 'assistant'],
      [4, 'tool-call'],
      [6, 'compaction'],
      [7, 'handoff'],
      [8, 'notice'],
    ]);
    expect(folded).toMatchObject({
      sourceEntryCount: 12,
      eligibleEntryCount: 6,
      excludedEntryCounts: [
        { category: 'conversation', count: 1 },
        { category: 'tool-results', count: 1 },
        { category: 'reasoning', count: 1 },
        { category: 'diagnostics', count: 3 },
      ],
    });
    expect(projected[0]).toMatchObject({
      abridged: true,
      attributes: [
        { name: 'origin', value: 'cli' },
        { name: 'style', value: 'notice' },
        { name: 'title', value: 'Detached specialist callback' },
      ],
    });
    expect(projected[0].attributes.map((attribute) => attribute.name)).not.toContain('disclosure');
    expect(projected[0].body).toContain('[data URL omitted from export]');
    expect(projected[2]).toMatchObject({
      abridged: true,
      attributes: [{ name: 'type', value: 'bash-tool-use' }],
    });
    expect(projected[1].body.length).toBeLessThanOrEqual(HANDOFF_ARTIFACT_BODY_MAX_CHARS);
    expect(projected[1].body.endsWith('...')).toBe(true);
    expect(projected[4].attributes).toEqual([
      { name: 'from-agent', value: 'claude' },
      { name: 'to-agent', value: 'codex' },
      { name: 'from-model', value: 'haiku' },
      { name: 'to-model', value: 'gpt-test' },
    ]);
    expect(JSON.stringify(projected)).not.toContain('secret-payload');
    expect(JSON.stringify(projected)).not.toContain('private result');
    expect(JSON.stringify(projected)).not.toContain('reasoning');
  });

  it('emits exact leading, middle, trailing, and all-omitted eligible gaps', () => {
    const entries = [
      source(1, 0, 1_000),
      source(2, 0, 10, 'user'),
      source(3, 1, 1_000),
      source(4, 1, 10, 'user'),
      source(5, 2, 1_000),
      source(6, 2, 10, 'user'),
      source(7, 3, 1_000),
      source(8, 3, 10, 'user'),
      source(9, 4, 1_000),
    ];
    const selected = selectHandoffArtifactEntries({
      entries,
      maximumCost: 500,
      cost: (text) => text.length,
    });

    expect(selected.nodes.map((node) => node.kind === 'entry'
      ? ['entry', node.entry.source.ordinal]
      : ['gap', node.gap.afterOrdinal, node.gap.beforeOrdinal, node.gap.omittedEligibleEntryCount]))
      .toEqual([
        ['gap', null, 2, 1],
        ['entry', 2],
        ['gap', 2, 4, 1],
        ['entry', 4],
        ['gap', 4, 6, 1],
        ['entry', 6],
        ['gap', 6, 8, 1],
        ['entry', 8],
        ['gap', 8, null, 1],
      ]);

    const omitted = selectHandoffArtifactEntries({
      entries,
      maximumCost: 0,
      cost: (text) => text.length,
    });
    expect(omitted.nodes).toEqual([{
      kind: 'gap',
      gap: { afterOrdinal: null, beforeOrdinal: null, omittedEligibleEntryCount: entries.length },
    }]);
  });

  it('refits one latest source element without splitting Unicode', () => {
    const selection = selectHandoffArtifactEntries({
      entries: [{
        ordinal: 1,
        level: 1,
        turn: 0,
        tag: 'assistant',
        attributes: [],
        body: '🙂'.repeat(200),
        abridged: false,
      }],
      maximumCost: 120,
      cost: (text) => text.length,
    });

    expect(selection.includedEntryCount).toBe(1);
    expect(selection.abridgedEntryCount).toBe(1);
    expect(selection.nodes[0].entry.xml).toContain('abridged="true"');
    expect(selection.nodes[0].entry.xml.isWellFormed()).toBe(true);
  });
});

function entry(ordinal, message) {
  return { kind: 'message', ordinal, category: exportCategoryForMessage(message), message };
}

function source(ordinal, turn, bodyLength, tag = 'assistant') {
  return {
    ordinal,
    level: tag === 'user' ? 0 : 1,
    turn,
    tag,
    attributes: [],
    body: 'x'.repeat(bodyLength),
    abridged: false,
  };
}
