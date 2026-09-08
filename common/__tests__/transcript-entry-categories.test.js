import { describe, expect, it } from 'bun:test';
import {
  AgentSwitchMessage,
  AssistantMessage,
  BashToolUseMessage,
  CliRowMessage,
  CompactionMessage,
  ErrorMessage,
  PermissionResolvedMessage,
  ThinkingMessage,
  ToolResultMessage,
  TranscriptNoticeMessage,
  UserMessage,
} from '../chat-types.ts';
import {
  canonicalTranscriptEntryOptionalCategories,
  transcriptEntryCategoryForMessage,
} from '../transcript-entry-categories.ts';

const TS = '2026-09-07T00:00:00.000Z';

describe('transcript entry categories', () => {
  it('classifies the conversation spine and every optional category', () => {
    expect([
      new UserMessage(TS, 'question'),
      new AssistantMessage(TS, 'answer'),
      new CompactionMessage(TS, 'auto', 'summary'),
      new TranscriptNoticeMessage(TS, 'quarantined', {
        type: 'carryover-migration-quarantine',
        artifactId: 'artifact-1',
        errorCode: 'INVALID_ARTIFACT',
      }),
    ].map(transcriptEntryCategoryForMessage)).toEqual([
      'conversation',
      'conversation',
      'conversation',
      'conversation',
    ]);

    expect([
      new BashToolUseMessage(TS, 'tool-1', 'bun test'),
      new ToolResultMessage(TS, 'tool-1', { output: 'ok' }, false),
      new ThinkingMessage(TS, 'reasoning'),
      new PermissionResolvedMessage(TS, 'permission-1', true),
      new ErrorMessage(TS, 'failed'),
      new CliRowMessage(TS, 'note', { style: 'notice' }, 'plain'),
      new TranscriptNoticeMessage(TS, 'preambles', {
        type: 'preamble-selection-changed',
        preambles: [],
      }),
      new AgentSwitchMessage(TS, 'claude', 'codex'),
    ].map(transcriptEntryCategoryForMessage)).toEqual([
      'tool-calls',
      'tool-results',
      'reasoning',
      'permissions',
      'diagnostics',
      'diagnostics',
      'diagnostics',
      'handoffs',
    ]);
  });

  it('canonicalizes optional categories in contract order', () => {
    expect(canonicalTranscriptEntryOptionalCategories([
      'handoffs',
      'tool-results',
      'tool-calls',
      'tool-results',
    ])).toEqual(['tool-calls', 'tool-results', 'handoffs']);
  });
});
