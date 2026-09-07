import { describe, expect, it } from 'bun:test';
import {
  CHAT_PREAMBLE_SELECTION_BODY_MAX_BYTES,
  parseChatPreambleSelectionTargetResponse,
  parsePreambleSelectionPartialError,
  parsePreambleSelectionPreviewRequest,
  parsePreambleSelectionPreviewResponse,
  parseUpdateChatPreambleSelectionRequest,
  parseUpdateChatPreambleSelectionResponse,
} from '../chat-preamble-selection-contracts.js';

const ID_A = '3502b645-222b-49d2-ac39-1c91f9fb1174';
const ID_B = '80becfa6-c9c7-4b31-9190-fd23c0bedf9c';
const ID_C = '936903ad-8b98-43eb-a7d4-c17ce0dc18d8';
const VIEW = '12345678-1234-4123-8123-123456789abc';

describe('chat preamble selection contracts', () => {
  it('parses a strict update request and rejects malformed identities', () => {
    expect(parseUpdateChatPreambleSelectionRequest({
      chatId: '1783725900000200',
      transcriptViewId: VIEW,
      clientRequestId: 'req-1',
      clientMessageId: 'msg-1',
      expectedRevision: 3,
      orderedPreambleIds: [ID_B, ID_A],
    })).toEqual({
      chatId: '1783725900000200',
      transcriptViewId: VIEW,
      clientRequestId: 'req-1',
      clientMessageId: 'msg-1',
      expectedRevision: 3,
      orderedPreambleIds: [ID_B, ID_A],
    });
    expect(() => parseUpdateChatPreambleSelectionRequest({
      chatId: '1783725900000200',
      transcriptViewId: VIEW,
      clientRequestId: 'req-1',
      clientMessageId: 'msg-1',
      expectedRevision: 3,
      orderedPreambleIds: [ID_A, ID_A],
    })).toThrow();
    expect(() => parseUpdateChatPreambleSelectionRequest({
      chatId: '1783725900000200',
      transcriptViewId: VIEW,
      clientRequestId: 'req-1',
      clientMessageId: 'msg-1',
      expectedRevision: 3,
      orderedPreambleIds: ['not-a-uuid'],
    })).toThrow();
    expect(() => parseUpdateChatPreambleSelectionRequest({
      chatId: '1783725900000200',
      transcriptViewId: VIEW,
      clientRequestId: 'req-1',
      clientMessageId: 'msg-1',
      expectedRevision: -1,
      orderedPreambleIds: [],
    })).toThrow();
    expect(() => parseUpdateChatPreambleSelectionRequest({
      chatId: '1783725900000200',
      transcriptViewId: VIEW,
      clientRequestId: 'req-1',
      clientMessageId: 'msg-1',
      expectedRevision: 3,
      orderedPreambleIds: [],
      extra: true,
    })).toThrow('extra is not supported');
    // Arbitrary nonblank identities and non-chat IDs reject.
    expect(() => parseUpdateChatPreambleSelectionRequest({
      chatId: 'not-a-chat-id',
      transcriptViewId: VIEW,
      clientRequestId: 'req-1',
      clientMessageId: 'msg-1',
      expectedRevision: 3,
      orderedPreambleIds: [],
    })).toThrow();
    expect(() => parseUpdateChatPreambleSelectionRequest({
      chatId: '1783725900000200',
      transcriptViewId: 'not-a-view',
      clientRequestId: 'req-1',
      clientMessageId: 'msg-1',
      expectedRevision: 3,
      orderedPreambleIds: [],
    })).toThrow();
    expect(() => parsePreambleSelectionPreviewRequest({
      projectPath: '/repo',
      unexpected: 1,
    })).toThrow('unexpected is not supported');
  });

  it('requires canonical UUID order in preview requests but allows omitted IDs', () => {
    expect(parsePreambleSelectionPreviewRequest({ projectPath: '/repo' }))
      .toEqual({ projectPath: '/repo' });
    expect(parsePreambleSelectionPreviewRequest({
      projectPath: '/repo',
      orderedPreambleIds: [],
    })).toEqual({ projectPath: '/repo', orderedPreambleIds: [] });
    expect(() => parsePreambleSelectionPreviewRequest({
      projectPath: '/repo',
      orderedPreambleIds: [ID_A.toUpperCase()],
    })).toThrow();
    expect(() => parsePreambleSelectionPreviewRequest({})).toThrow();
  });

  it('parses target, update, and preview responses strictly', () => {
    const projection = {
      catalogRevision: 2,
      eligiblePreambles: [{ id: ID_A, title: 'Repository conventions' }],
      unavailable: [{ id: ID_B, reason: 'disabled' }],
    };
    expect(parseChatPreambleSelectionTargetResponse({
      success: true,
      chatId: '1783725900000200',
      transcriptViewId: VIEW,
      canonicalProjectPath: '/repo',
      selection: { revision: 1, orderedPreambleIds: [ID_A, ID_B] },
      projection,
    })).toEqual({
      success: true,
      chatId: '1783725900000200',
      transcriptViewId: VIEW,
      canonicalProjectPath: '/repo',
      selection: { revision: 1, orderedPreambleIds: [ID_A, ID_B] },
      projection,
    });
    // A projection that does not exactly partition the selection rejects.
    expect(parseChatPreambleSelectionTargetResponse({
      success: true,
      chatId: '1783725900000200',
      transcriptViewId: VIEW,
      canonicalProjectPath: '/repo',
      selection: { revision: 1, orderedPreambleIds: [ID_A, ID_B] },
      projection: {
        catalogRevision: 2,
        eligiblePreambles: [{ id: ID_A, title: 'Repository conventions' }],
        unavailable: [],
      },
    })).toBeNull();

    expect(parseChatPreambleSelectionTargetResponse({
      success: true,
      chatId: '1783725900000200',
      transcriptViewId: VIEW,
      canonicalProjectPath: '/repo',
      selection: { revision: 1, orderedPreambleIds: [ID_A, ID_B, ID_C] },
      projection: {
        catalogRevision: 2,
        eligiblePreambles: [
          { id: ID_A, title: 'Repository conventions' },
          { id: ID_C, title: 'Security constraints' },
        ],
        unavailable: [{ id: ID_B, reason: 'missing' }],
      },
    })).not.toBeNull();
    expect(parseChatPreambleSelectionTargetResponse({
      success: true,
      chatId: '1783725900000200',
      transcriptViewId: VIEW,
      selection: { revision: 1, orderedPreambleIds: [ID_A, ID_A] },
      projection,
    })).toBeNull();

    const partitioned = {
      catalogRevision: 2,
      eligiblePreambles: [{ id: ID_A, title: 'Repository conventions' }],
      unavailable: [{ id: ID_B, reason: 'disabled' }],
    };
    expect(parseUpdateChatPreambleSelectionResponse({
      success: true,
      commandType: 'chat-preambles-update',
      clientRequestId: 'req-1',
      clientMessageId: 'msg-1',
      chatId: '1783725900000200',
      transcriptViewId: VIEW,
      status: 'updated',
      mutationRevision: 2,
      noticeOrdinal: 5,
      selection: { revision: 2, orderedPreambleIds: [ID_A, ID_B] },
      projection: partitioned,
    })).toMatchObject({ status: 'updated', mutationRevision: 2, noticeOrdinal: 5 });
    expect(parseUpdateChatPreambleSelectionResponse({
      success: true,
      commandType: 'chat-preambles-update',
      clientRequestId: 'req-1',
      clientMessageId: 'msg-1',
      chatId: '1783725900000200',
      transcriptViewId: VIEW,
      status: 'bogus',
      mutationRevision: 2,
      noticeOrdinal: null,
      selection: { revision: 2, orderedPreambleIds: [ID_A, ID_B] },
      projection: partitioned,
    })).toBeNull();

    expect(parsePreambleSelectionPreviewResponse({
      success: true,
      canonicalProjectPath: '/repo',
      orderedPreambleIds: [ID_A, ID_B],
      projection,
    })).toEqual({
      success: true,
      canonicalProjectPath: '/repo',
      orderedPreambleIds: [ID_A, ID_B],
      projection,
    });
    // Unbounded, duplicate, or mispartitioned preview IDs reject.
    expect(parsePreambleSelectionPreviewResponse({
      success: true,
      canonicalProjectPath: '/repo',
      orderedPreambleIds: [ID_A, ID_A],
      projection,
    })).toBeNull();
    expect(parsePreambleSelectionPreviewResponse({
      success: true,
      canonicalProjectPath: '/repo',
      orderedPreambleIds: [ID_A, ID_B],
      projection: {
        catalogRevision: 2,
        eligiblePreambles: [{ id: ID_A, title: 'Repository conventions' }],
        unavailable: [],
      },
    })).toBeNull();
  });

  it('rejects unknown keys, malformed identities, and inconsistent update outcomes', () => {
    const projection = {
      catalogRevision: 2,
      eligiblePreambles: [{ id: ID_A, title: 'Repository conventions' }],
      unavailable: [],
    };
    const target = {
      success: true,
      chatId: '1783725900000200',
      transcriptViewId: VIEW,
      canonicalProjectPath: '/repo',
      selection: { revision: 2, orderedPreambleIds: [ID_A] },
      projection,
    };
    expect(parseChatPreambleSelectionTargetResponse({ ...target, extra: true })).toBeNull();
    expect(parseChatPreambleSelectionTargetResponse({ ...target, chatId: 'chat-1' })).toBeNull();
    expect(parseChatPreambleSelectionTargetResponse({ ...target, transcriptViewId: 'view-1' }))
      .toBeNull();

    const update = {
      success: true,
      commandType: 'chat-preambles-update',
      clientRequestId: 'req-1',
      clientMessageId: 'msg-1',
      chatId: target.chatId,
      transcriptViewId: VIEW,
      status: 'updated',
      mutationRevision: 2,
      noticeOrdinal: 5,
      selection: target.selection,
      projection,
    };
    expect(parseUpdateChatPreambleSelectionResponse({ ...update, extra: true })).toBeNull();
    expect(parseUpdateChatPreambleSelectionResponse({ ...update, clientRequestId: ' req-1' }))
      .toBeNull();
    expect(parseUpdateChatPreambleSelectionResponse({
      ...update,
      selection: { revision: 3, orderedPreambleIds: [ID_A] },
    })).toBeNull();
    expect(parseUpdateChatPreambleSelectionResponse({
      ...update,
      status: 'unchanged',
      noticeOrdinal: null,
      selection: { revision: 3, orderedPreambleIds: [ID_A] },
    })).toBeNull();
    expect(parseUpdateChatPreambleSelectionResponse({
      ...update,
      status: 'duplicate',
      noticeOrdinal: null,
    })).toBeNull();
    expect(parseUpdateChatPreambleSelectionResponse({
      ...update,
      status: 'duplicate',
      mutationRevision: 3,
    })).toBeNull();

    expect(parsePreambleSelectionPreviewResponse({
      success: true,
      canonicalProjectPath: '/repo',
      orderedPreambleIds: [ID_A],
      projection,
      extra: true,
    })).toBeNull();
  });

  it('parses typed partial errors with committed state and rejects mismatches', () => {
    expect(parsePreambleSelectionPartialError({
      success: false,
      errorCode: 'PREAMBLE_SELECTION_NOTICE_FAILED',
      message: 'The selection was saved, but its transcript notice could not be recorded.',
      retryable: false,
      selectionCommitted: true,
      selection: { revision: 4, orderedPreambleIds: [] },
    })).toEqual({
      success: false,
      errorCode: 'PREAMBLE_SELECTION_NOTICE_FAILED',
      message: 'The selection was saved, but its transcript notice could not be recorded.',
      retryable: false,
      selectionCommitted: true,
      selection: { revision: 4, orderedPreambleIds: [] },
    });
    expect(parsePreambleSelectionPartialError({
      success: false,
      errorCode: 'PREAMBLE_SELECTION_SAVE_UNKNOWN',
      message: 'unknown',
      retryable: false,
      selectionCommitted: 'unknown',
    })).toMatchObject({ selectionCommitted: 'unknown' });
    expect(parsePreambleSelectionPartialError({
      success: false,
      errorCode: 'PREAMBLE_SELECTION_REVISION_CONFLICT',
      message: 'conflict',
      retryable: true,
      selectionCommitted: true,
    })).toBeNull();
    expect(parsePreambleSelectionPartialError({
      success: false,
      errorCode: 'PREAMBLE_SELECTION_SAVE_UNKNOWN',
      message: 'unknown',
      retryable: true,
      selectionCommitted: 'unknown',
    })).toBeNull();
    expect(parsePreambleSelectionPartialError({
      success: false,
      errorCode: 'PREAMBLE_SELECTION_NOTICE_FAILED',
      message: 'x',
      retryable: false,
    })).toBeNull();
    expect(parsePreambleSelectionPartialError({
      success: false,
      errorCode: 'PREAMBLE_SELECTION_NOTICE_FAILED',
      message: 'notice failed',
      retryable: false,
      selectionCommitted: true,
    })).toBeNull();
    expect(parsePreambleSelectionPartialError({
      success: false,
      errorCode: 'PREAMBLE_SELECTION_SAVE_UNKNOWN',
      message: 'unknown',
      retryable: false,
      selectionCommitted: 'unknown',
      extra: true,
    })).toBeNull();
  });

  it('advertises the request body limit used by the routes', () => {
    expect(CHAT_PREAMBLE_SELECTION_BODY_MAX_BYTES).toBe(32 * 1024);
  });
});
