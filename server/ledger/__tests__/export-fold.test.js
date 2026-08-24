import { describe, expect, it } from 'bun:test';
import {
  AgentSwitchMessage,
  AssistantMessage,
  BashToolUseMessage,
  CompactionMessage,
  ErrorMessage,
  PermissionExpiredMessage,
  ThinkingMessage,
  ToolResultMessage,
  TranscriptNoticeMessage,
  UserMessage,
} from '../../../common/chat-types.ts';
import {
  exportCategoryForMessage,
  filterTranscriptExportEntries,
  foldRowsForExport,
} from '../export-fold.ts';
import { transcriptViewId } from '../contracts.ts';

const AT = '2026-08-23T00:00:00.000Z';
const VIEW_ID = transcriptViewId('view-1');

describe('transcript export fold', () => {
  it('classifies the complete rendered vocabulary into semantic export categories', () => {
    expect(exportCategoryForMessage(new UserMessage(AT, 'prompt'))).toBe('conversation');
    expect(exportCategoryForMessage(new AssistantMessage(AT, 'answer'))).toBe('conversation');
    expect(exportCategoryForMessage(new CompactionMessage(AT, 'auto', 'summary')))
      .toBe('conversation');
    expect(exportCategoryForMessage(new ThinkingMessage(AT, 'reasoning'))).toBe('reasoning');
    expect(exportCategoryForMessage(new BashToolUseMessage(AT, 'tool-1', 'pwd')))
      .toBe('tool-calls');
    expect(exportCategoryForMessage(new ToolResultMessage(AT, 'tool-1', { output: '/x' }, false)))
      .toBe('tool-results');
    expect(exportCategoryForMessage(new PermissionExpiredMessage(AT, 'permission-1')))
      .toBe('permissions');
    expect(exportCategoryForMessage(new ErrorMessage(AT, 'failed'))).toBe('diagnostics');
    expect(exportCategoryForMessage(new TranscriptNoticeMessage(AT, 'notice')))
      .toBe('diagnostics');
    expect(exportCategoryForMessage(new AgentSwitchMessage(AT, 'claude', 'codex')))
      .toBe('handoffs');
  });

  it('keeps quarantine notices in the non-excludable conversation spine', () => {
    const message = new TranscriptNoticeMessage(AT, 'Earlier content is unavailable.', {
      type: 'carryover-migration-quarantine',
      artifactId: 'artifact-1',
      errorCode: 'CARRYOVER_PARSE_FAILED',
    });
    expect(exportCategoryForMessage(message)).toBe('conversation');
  });

  it('drops support-only sessions, keeps run endings, and never exposes provider metadata', () => {
    const rows = [
      {
        viewId: VIEW_ID,
        ordinal: 1,
        at: AT,
        providerMeta: { secret: 'provider-sentinel' },
        kind: 'provider-row',
        message: new AssistantMessage(AT, 'answer'),
      },
      {
        viewId: VIEW_ID,
        ordinal: 2,
        at: AT,
        providerMeta: { nativePath: '/native/session' },
        kind: 'session',
        detail: { agentSessionId: 'session-1', nativeSession: null, nativeSeedReceipt: null },
      },
      {
        viewId: VIEW_ID,
        ordinal: 3,
        at: AT,
        providerMeta: { secret: 'run-sentinel' },
        kind: 'run-ended',
        outcome: 'failed',
        origin: 'provider',
        error: { code: 'MODEL_FAILED', message: 'failure' },
      },
    ];
    const entries = foldRowsForExport(rows);

    expect(entries).toEqual([
      {
        kind: 'message',
        ordinal: 1,
        category: 'conversation',
        message: new AssistantMessage(AT, 'answer'),
      },
      {
        kind: 'run-ended',
        ordinal: 3,
        category: 'diagnostics',
        at: AT,
        outcome: 'failed',
        origin: 'provider',
        error: { code: 'MODEL_FAILED', message: 'failure' },
      },
    ]);
    expect(JSON.stringify(entries)).not.toContain('sentinel');
    expect(JSON.stringify(entries)).not.toContain('/native/session');
  });

  it('filters only requested categories while preserving original ordinals and the spine', () => {
    const entries = foldRowsForExport([
      row(1, new UserMessage(AT, 'prompt')),
      row(2, new BashToolUseMessage(AT, 'tool-1', 'pwd')),
      row(3, new ToolResultMessage(AT, 'tool-1', { output: '/x' }, false)),
      row(4, new AssistantMessage(AT, 'answer')),
    ]);
    expect(filterTranscriptExportEntries(entries, ['tool-calls', 'tool-results'])).toEqual({
      entries: [entries[0], entries[3]],
      omitted: [
        { category: 'tool-calls', count: 1 },
        { category: 'tool-results', count: 1 },
      ],
    });
  });

  it('keeps styled CLI user input when diagnostics are excluded', () => {
    const styled = new UserMessage(AT, 'real prompt', [], undefined, {
      origin: 'cli',
      style: 'error',
    });
    const entries = foldRowsForExport([{
      viewId: VIEW_ID,
      ordinal: 7,
      at: AT,
      providerMeta: null,
      kind: 'user-input',
      detail: { clientMessageId: 'message-1', message: styled, attachments: [], steer: false },
    }]);
    expect(filterTranscriptExportEntries(entries, ['diagnostics']).entries).toEqual(entries);
  });
});

function row(ordinal, message) {
  return {
    viewId: VIEW_ID,
    ordinal,
    at: AT,
    providerMeta: null,
    kind: 'provider-row',
    message,
  };
}
