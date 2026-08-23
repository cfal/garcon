import { describe, expect, it } from 'bun:test';
import {
  AgentSwitchMessage,
  AssistantMessage,
  BashToolUseMessage,
  ErrorMessage,
  ThinkingMessage,
  ToolResultMessage,
  TranscriptNoticeMessage,
  UserMessage,
} from '../../../../common/chat-types.ts';
import { transcriptViewId } from '../../../ledger/contracts.ts';
import { TranscriptExportService } from '../service.ts';

const AT = '2026-08-23T00:00:00.000Z';
const CHAT_ID = '1787505989127000';
const VIEW_ID = transcriptViewId('view-1');

describe('TranscriptExportService', () => {
  it('filters every category while preserving the conversation spine and disclosure', async () => {
    const rows = [
      providerRow(1, new UserMessage(AT, 'prompt')),
      providerRow(2, new BashToolUseMessage(AT, 'tool-1', 'pwd')),
      providerRow(3, new ToolResultMessage(AT, 'tool-1', { output: '/workspace' }, false)),
      providerRow(4, new ThinkingMessage(AT, 'reasoning')),
      providerRow(5, new ErrorMessage(AT, 'diagnostic')),
      providerRow(6, new AgentSwitchMessage(AT, 'claude', 'codex')),
      {
        viewId: VIEW_ID,
        ordinal: 7,
        at: AT,
        providerMeta: null,
        kind: 'permission-expired',
        lifecycle: { kind: 'expired', permissionOccurrenceId: 'permission-1' },
      },
      providerRow(8, new AssistantMessage(AT, 'answer')),
      providerRow(9, new TranscriptNoticeMessage(AT, 'migration disclosure', {
        type: 'carryover-migration-quarantine',
        artifactId: 'artifact-1',
        errorCode: 'MIGRATION_FAILED',
      })),
    ];
    const service = createService(rows);
    const exclusions = [
      'tool-calls',
      'tool-results',
      'reasoning',
      'permissions',
      'diagnostics',
      'handoffs',
    ];

    const response = await service.export({ chatId: CHAT_ID, format: 'xml', exclusions }, signal());

    expect(response.entryCount).toBe(3);
    expect(response.totalEntryCount).toBe(9);
    expect(response.omitted).toEqual(exclusions.map((category) => ({ category, count: 1 })));
    expect(response.document).toContain('<user ordinal="1"');
    expect(response.document).toContain('<assistant ordinal="8"');
    expect(response.document).toContain('migration disclosure');
    expect(response.document).not.toContain('tool-1');
    expect(response.document).not.toContain('<handoff');
  });

  it('never exposes session details or provider metadata in either format', async () => {
    const rows = [
      {
        ...providerRow(1, new AssistantMessage(AT, 'answer')),
        providerMeta: { sentinel: 'provider-secret' },
      },
      {
        viewId: VIEW_ID,
        ordinal: 2,
        at: AT,
        providerMeta: { sentinel: 'session-provider-secret' },
        kind: 'session',
        detail: {
          agentSessionId: 'native-secret',
          nativeSession: null,
          nativeSeedReceipt: null,
        },
      },
    ];
    const service = createService(rows);

    for (const format of ['markdown', 'xml']) {
      const response = await service.export({
        chatId: CHAT_ID,
        format,
        exclusions: [],
      }, signal());
      expect(response.document).not.toContain('provider-secret');
      expect(response.document).not.toContain('native-secret');
    }
  });

  it('returns a typed not-found failure before reading the transcript', async () => {
    let read = false;
    const service = new TranscriptExportService({
      summaries: { buildSummary: () => null },
      transcripts: { exportSnapshot: async () => { read = true; throw new Error('unexpected'); } },
      now: () => AT,
    });

    await expect(service.export({
      chatId: CHAT_ID,
      format: 'markdown',
      exclusions: [],
    }, signal())).rejects.toMatchObject({
      code: 'SESSION_NOT_FOUND',
      status: 404,
      retryable: false,
    });
    expect(read).toBe(false);
  });
});

function createService(rows) {
  return new TranscriptExportService({
    summaries: {
      buildSummary: () => ({
        chat: {
          id: CHAT_ID,
          title: 'Export fixture',
          agentId: 'codex',
          agentOwnershipEpoch: 'epoch-1',
          carryOverRevision: 'revision-1',
          model: 'gpt-test',
          apiProviderId: null,
          modelEndpointId: null,
          modelProtocol: null,
          permissionMode: 'default',
          thinkingMode: 'default',
          projectPath: '/workspace/project',
          tags: [],
          canReloadFromNativeHistory: false,
          activity: { createdAt: AT, lastActivityAt: AT },
        },
      }),
    },
    transcripts: {
      exportSnapshot: async () => ({
        transcriptViewId: VIEW_ID,
        lastOrdinal: rows.at(-1)?.ordinal ?? 0,
        rows,
      }),
    },
    now: () => AT,
  });
}

function providerRow(ordinal, message) {
  return {
    viewId: VIEW_ID,
    ordinal,
    at: AT,
    providerMeta: null,
    kind: 'provider-row',
    message,
  };
}

function signal() {
  return new AbortController().signal;
}
