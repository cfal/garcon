import { describe, expect, it, mock } from 'bun:test';
import { parseChatHandoffArtifactResponse } from '../../../../common/chat-handoff-artifact-contracts.ts';
import {
  AssistantMessage,
  ToolResultMessage,
  UserMessage,
} from '../../../../common/chat-types.ts';
import { transcriptViewId } from '../../../ledger/contracts.ts';
import { DomainError } from '../../../lib/domain-error.ts';
import { HandoffArtifactService } from '../service.ts';

const AT = '2026-08-26T00:00:00.000Z';
const CHAT_ID = '1787505989127000';
const VIEW_ID = transcriptViewId('view-synthetic-1');

describe('HandoffArtifactService', () => {
  it('returns not-found before reading a transcript', async () => {
    const exportSnapshot = mock(async () => { throw new Error('unexpected read'); });
    const service = new HandoffArtifactService({
      summaries: { buildSummary: () => null },
      transcripts: { exportSnapshot },
    });

    await expect(service.create(request(), signal())).rejects.toMatchObject({
      code: 'SESSION_NOT_FOUND',
      status: 404,
      retryable: false,
    });
    expect(exportSnapshot).not.toHaveBeenCalled();
  });

  it('uses one pinned snapshot and returns its exact view and watermark', async () => {
    const liveRows = [
      providerRow(1, new UserMessage(AT, 'Synthetic objective')),
      providerRow(2, new AssistantMessage(AT, 'Synthetic answer')),
      providerRow(3, new ToolResultMessage(AT, 'tool-1', { output: 'hidden' }, false)),
      {
        viewId: VIEW_ID,
        ordinal: 4,
        at: AT,
        providerMeta: { nativePath: 'secret' },
        kind: 'session',
        detail: {
          agentSessionId: 'native-secret',
          nativeSession: null,
          nativeSeedReceipt: null,
        },
      },
    ];
    const exportSnapshot = mock(async () => {
      const rows = [...liveRows];
      liveRows.push(providerRow(5, new AssistantMessage(AT, 'Concurrent append')));
      return { transcriptViewId: VIEW_ID, lastOrdinal: 4, rows };
    });
    const service = createService(exportSnapshot);

    const response = await service.create(request(131_072), signal());

    expect(parseChatHandoffArtifactResponse(response)).toEqual(response);
    expect(exportSnapshot).toHaveBeenCalledTimes(1);
    expect(response).toMatchObject({
      chatId: CHAT_ID,
      transcriptViewId: VIEW_ID,
      lastOrdinal: 4,
      generatedAt: AT,
      contextWindowTokens: 131_072,
      usableTokenBudget: 98_304,
      fold: 'handoff-v1',
      gapUnit: 'eligible-entry',
      sourceEntryCount: 3,
      eligibleEntryCount: 2,
      excludedEntryCounts: [{ category: 'tool-results', count: 1 }],
      includedEntryCount: 2,
      budgetOmittedEntryCount: 0,
      projectionTruncated: false,
    });
    expect(response.document).toContain('Synthetic objective');
    expect(response.document).not.toContain('Concurrent append');
    expect(response.document).not.toContain('native-secret');
    expect(response.document).not.toContain('secret');
    expect(response.document).not.toContain('hidden');
    expect(response.document).toContain('<fixed-fold-excluded tool-results="1"/>');
  });

  it('preserves snapshot replacement failures unchanged', async () => {
    const failure = new DomainError('SOURCE_REVISION_CHANGED', 'View changed', 409, true);
    const service = createService(async () => { throw failure; });

    await expect(service.create(request(), signal())).rejects.toBe(failure);
  });

  it('rejects invalid context windows before any transcript read', async () => {
    const exportSnapshot = mock(async () => ({
      transcriptViewId: VIEW_ID,
      lastOrdinal: 0,
      rows: [],
    }));
    const service = createService(exportSnapshot);

    await expect(service.create(request(1_023), signal())).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
      status: 400,
    });
    expect(exportSnapshot).not.toHaveBeenCalled();
  });
});

function createService(exportSnapshot) {
  return new HandoffArtifactService({
    summaries: { buildSummary: () => ({ chat: chat() }) },
    transcripts: { exportSnapshot },
    now: () => AT,
  });
}

function request(contextWindowTokens = 500_000) {
  return { chatId: CHAT_ID, contextWindowTokens };
}

function chat() {
  return {
    id: CHAT_ID,
    title: 'Artifact fixture',
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
  };
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
