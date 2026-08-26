import { describe, expect, it } from 'bun:test';
import {
  AgentSwitchMessage,
  AssistantMessage,
  BashToolUseMessage,
  CompactionMessage,
  TranscriptNoticeMessage,
  UserMessage,
} from '../../../../common/chat-types.ts';
import { estimateHandoffTokens } from '../../handoff-token-budget.ts';
import { handoffArtifactEntries } from '../projection.ts';
import { renderFittedHandoffArtifact } from '../xml.ts';

const AT = '2026-08-26T00:00:00.000Z';

describe('handoff artifact XML', () => {
  it('renders the purpose-built ordinal vocabulary byte-for-byte', () => {
    const messages = [
      new UserMessage(AT, 'Objective & <scope>'),
      new AssistantMessage(AT, 'Decision'),
      new BashToolUseMessage(AT, 'tool-1', 'pwd'),
      new CompactionMessage(AT, 'auto', 'Older summary'),
      new AgentSwitchMessage(AT, 'claude', 'codex'),
      new TranscriptNoticeMessage(AT, 'Current state', { type: 'handoff-summary' }),
    ];
    const rendered = render(messages, 200_000);

    expect(rendered.document).toBe(`<?xml version="1.0" encoding="UTF-8"?>
<handoff-artifact version="1" chat-id="1787505989127000" transcript-view-id="view-1" last-ordinal="6" context-window-tokens="200000" usable-token-budget="150000" estimated-tokens="293" total-entries="6" included-entries="6" omitted-entries="0" abridged-entries="0" gaps="0" truncated="false">
  <chat title="Artifact fixture" agent="codex" model="gpt-test"/>
  <entries>
    <user ordinal="1">
      <text>Objective &amp; &lt;scope&gt;</text>
    </user>
    <assistant ordinal="2">
      <text>Decision</text>
    </assistant>
    <tool-call ordinal="3" type="bash-tool-use">
      <text>pwd</text>
    </tool-call>
    <compaction ordinal="4" trigger="auto">
      <text>Older summary</text>
    </compaction>
    <handoff ordinal="5" from-agent="claude" to-agent="codex"/>
    <notice ordinal="6" type="handoff-summary">
      <text>Current state</text>
    </notice>
  </entries>
</handoff-artifact>
`);
    expect(rendered.estimatedTokens).toBe(estimateHandoffTokens(rendered.document));
    expect(rendered.estimatedTokens).toBeLessThanOrEqual(rendered.usableTokenBudget);
  });

  it('is deterministic for identical complete renderer inputs', () => {
    const messages = [
      new UserMessage(AT, 'Synthetic objective'),
      new AssistantMessage(AT, 'Synthetic response'),
    ];

    expect(render(messages, 131_072).document).toBe(render(messages, 131_072).document);
  });

  it('fits the complete XML and exposes constrained omissions as gaps', () => {
    const messages = [];
    for (let index = 0; index < 80; index += 1) {
      messages.push(new UserMessage(AT, `Objective ${index} ${'x'.repeat(3_900)}`));
      messages.push(new AssistantMessage(AT, `Response ${index} ${'y'.repeat(3_900)}`));
    }

    const rendered = render(messages, 1_024);

    expect(rendered.estimatedTokens).toBe(estimateHandoffTokens(rendered.document));
    expect(rendered.estimatedTokens).toBeLessThanOrEqual(768);
    expect(rendered.omittedEntryCount).toBeGreaterThan(0);
    expect(rendered.gapCount).toBeGreaterThan(0);
    expect(rendered.truncated).toBe(true);
    expect(rendered.document).toContain('<gap ');
    expect(rendered.document).not.toContain('<earlier-turns-truncated');
  });

  it('fits a mid-sized window when gap overhead leaves a persistent overshoot', () => {
    const messages = [];
    for (let index = 0; index < 40; index += 1) {
      messages.push(new UserMessage(AT, `Objective ${index}`));
      messages.push(new AssistantMessage(AT, 'word '.repeat(500)));
    }

    const rendered = render(messages, 16_384);

    expect(rendered).not.toBeNull();
    expect(rendered.estimatedTokens).toBeLessThanOrEqual(12_288);
    expect(rendered.includedEntryCount).toBeGreaterThan(0);
    expect(rendered.omittedEntryCount).toBeGreaterThan(0);
    expect(rendered.gapCount).toBeGreaterThan(1);
  });

  it('renders an empty eligible source without a zero-count gap', () => {
    const rendered = renderFittedHandoffArtifact({
      chat: {
        id: '1787505989127000',
        title: 'Empty',
        agentId: 'codex',
        model: null,
      },
      transcriptViewId: 'view-empty',
      lastOrdinal: 0,
      contextWindowTokens: 1_024,
      entries: [],
    });

    expect(rendered).not.toBeNull();
    expect(rendered).toMatchObject({
      totalEntryCount: 0,
      includedEntryCount: 0,
      omittedEntryCount: 0,
      abridgedEntryCount: 0,
      gapCount: 0,
      truncated: false,
    });
    expect(rendered.document).toContain('  <entries/>\n');
    expect(rendered.document).not.toContain('<gap');
  });
});

function render(messages, contextWindowTokens) {
  const entries = handoffArtifactEntries(messages.map((message, index) => ({
    kind: 'message',
    ordinal: index + 1,
    category: 'conversation',
    message,
  })));
  return renderFittedHandoffArtifact({
    chat: {
      id: '1787505989127000',
      title: 'Artifact fixture',
      agentId: 'codex',
      model: 'gpt-test',
    },
    transcriptViewId: 'view-1',
    lastOrdinal: messages.length,
    contextWindowTokens,
    entries,
  });
}
