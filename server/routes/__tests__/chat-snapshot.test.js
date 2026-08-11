import { describe, expect, mock, test } from 'bun:test';
import { AgentIntegrationError } from '@garcon/server-agent-interface';
import { parseChatSnapshotResponse } from '../../../common/chat-snapshot.js';
import {
  TRANSCRIPT_TEMPORARILY_UNAVAILABLE_MESSAGE,
} from '../../lib/domain-error.js';

const routeLogger = {
  debug: mock(() => undefined),
  info: mock(() => undefined),
  warn: mock(() => undefined),
  error: mock(() => undefined),
};

import { createChatSnapshotRoutes } from '../chat-snapshot.js';

const CHAT_ID = '1785337200123456';
const TIMESTAMP = '2026-08-04T12:00:00.000Z';

function fixture(overrides = {}) {
  const calls = [];
  const summaries = overrides.summaries ?? {
    buildSummary: mock(() => {
      calls.push('summary');
      return {
        chat: {
          id: CHAT_ID,
          title: 'Implement validation',
          agentId: 'codex',
          agentOwnershipEpoch: 'epoch-1',
          carryOverRevision: 'carry-v1:0',
          model: 'gpt-5.4',
          apiProviderId: null,
          modelEndpointId: null,
          modelProtocol: null,
          permissionMode: 'acceptEdits',
          thinkingMode: 'high',
          projectPath: '/missing/project',
          tags: ['cli'],
          activity: { createdAt: TIMESTAMP, lastActivityAt: TIMESTAMP },
        },
        processingPhase: 'running',
      };
    }),
  };
  const execution = overrides.execution ?? {
    readChatExecutionControl: mock(async () => {
      calls.push('control');
      return {
        serverInstanceId: 'instance-1',
        entries: [{
          id: 'queued-1',
          content: 'Queued work',
          createdAt: TIMESTAMP,
          updatedAt: TIMESTAMP,
          revision: 1,
          status: 'queued',
          delivery: {
            clientRequestId: 'private-request',
            clientMessageId: 'private-message',
            turnId: 'private-turn',
          },
        }],
        recentlyDispatched: [],
        appliedCommands: [{
          key: 'private-command',
          operation: 'create',
          entryId: 'queued-1',
          appliedAt: TIMESTAMP,
        }],
        pause: null,
        reorderRevision: 0,
        version: 1,
        updatedAt: TIMESTAMP,
      };
    }),
  };
  const chatViews = overrides.chatViews ?? {
    getOrCreatePage: mock(async (_chatId, limit) => {
      calls.push('messages');
      return {
        generationId: 'generation-1',
        messages: [{
          seq: 1,
          message: { type: 'assistant-message', timestamp: TIMESTAMP, content: 'Working' },
        }],
        lastSeq: 1,
        pageOldestSeq: 1,
        hasMore: false,
        limit,
      };
    }),
  };
  const pendingInputs = overrides.pendingInputs ?? {
    reconcileRetainedHistory: mock(async () => { calls.push('reconcile'); }),
    listForTransport: mock(() => [{
      chatId: CHAT_ID,
      clientRequestId: 'request-1',
      content: 'Working',
      createdAt: TIMESTAMP,
      deliveryStatus: 'accepted',
      attachments: [{ name: 'image.png', mimeType: 'image/png' }],
    }]),
  };
  const transientFeeds = overrides.transientFeeds ?? {
    currentSnapshot: mock(() => null),
    snapshot: mock(({ chatId, agentOwnershipEpoch, generationId }) => ({
      serverInstanceId: 'instance-1',
      chatId,
      agentOwnershipEpoch,
      generationId,
      resetTransactionId: null,
      transientRevision: 0,
      stateDigest: 'transient-v1:empty',
      rows: [],
    })),
  };
  const routes = createChatSnapshotRoutes({
    summaries,
    execution,
    chatViews,
    transientFeeds,
    pendingInputs,
    logger: routeLogger,
    now: () => new Date(TIMESTAMP),
  });
  return { calls, summaries, execution, chatViews, transientFeeds, pendingInputs, routes };
}

async function getSnapshot(testFixture, query) {
  const url = new URL(`http://localhost/api/v1/chats/snapshot?${query}`);
  const response = await testFixture.routes['/api/v1/chats/snapshot'].GET(
    new Request(url),
    url,
  );
  return { response, body: await response.json() };
}

describe('GET /api/v1/chats/snapshot', () => {
  test('returns a bounded provider-neutral snapshot with default limit', async () => {
    const testFixture = fixture();
    const { response, body } = await getSnapshot(testFixture, `chatId=${CHAT_ID}`);

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(body).toMatchObject({
      observedAt: TIMESTAMP,
      messageLimit: 10,
      chat: { id: CHAT_ID, projectPath: '/missing/project' },
      processingPhase: 'running',
      control: {
        serverInstanceId: 'instance-1',
        queue: { entries: [{ id: 'queued-1', content: 'Queued work' }] },
      },
      transientFeed: {
        generationId: 'generation-1',
        rows: [],
      },
      pendingUserInputs: [{ attachments: [{ name: 'image.png' }] }],
      transcript: { availability: 'available', generationId: 'generation-1' },
    });
    expect(JSON.stringify(body)).not.toContain('private-request');
    expect(JSON.stringify(body)).not.toContain('private-command');
    expect(parseChatSnapshotResponse(body)).toMatchObject({ chat: { id: CHAT_ID } });
    expect(testFixture.chatViews.getOrCreatePage).toHaveBeenCalledWith(CHAT_ID, 10);
    expect(testFixture.calls).toEqual(['summary', 'control', 'messages', 'reconcile']);
  });

  test('skips transcript loading at zero while reconciling pending inputs', async () => {
    const testFixture = fixture();
    const { body } = await getSnapshot(testFixture, `chatId=${CHAT_ID}&limit=0`);

    expect(body).toMatchObject({
      messageLimit: 0,
      transcript: { availability: 'not-requested' },
    });
    expect(testFixture.chatViews.getOrCreatePage).not.toHaveBeenCalled();
    expect(testFixture.pendingInputs.reconcileRetainedHistory).toHaveBeenCalledWith(CHAT_ID);
  });

  test('accepts the maximum transcript limit', async () => {
    const testFixture = fixture();
    const { response } = await getSnapshot(testFixture, `chatId=${CHAT_ID}&limit=200`);

    expect(response.status).toBe(200);
    expect(testFixture.chatViews.getOrCreatePage).toHaveBeenCalledWith(CHAT_ID, 200);
  });

  test.each(['-1', '201', '1.5', '1e2', '', 'abc'])('rejects invalid limit %s', async (limit) => {
    const testFixture = fixture();
    const { response, body } = await getSnapshot(
      testFixture,
      `chatId=${CHAT_ID}&limit=${encodeURIComponent(limit)}`,
    );

    expect(response.status).toBe(400);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(body.errorCode).toBe('VALIDATION_FAILED');
    expect(testFixture.summaries.buildSummary).not.toHaveBeenCalled();
  });

  test('rejects malformed and missing chats without reading execution state', async () => {
    const malformedFixture = fixture();
    const malformed = await getSnapshot(malformedFixture, 'chatId=123');
    expect(malformed.response.status).toBe(400);
    expect(malformed.response.headers.get('Cache-Control')).toBe('no-store');

    const missingFixture = fixture({
      summaries: { buildSummary: mock(() => null) },
    });
    const missing = await getSnapshot(missingFixture, `chatId=${CHAT_ID}`);
    expect(missing.response.status).toBe(404);
    expect(missing.body.errorCode).toBe('SESSION_NOT_FOUND');
    expect(missing.response.headers.get('Cache-Control')).toBe('no-store');
    expect(missingFixture.execution.readChatExecutionControl).not.toHaveBeenCalled();
  });

  test('returns partial status when the transcript is unavailable', async () => {
    const testFixture = fixture({
      chatViews: {
        getOrCreatePage: mock(async () => {
          throw new AgentIntegrationError(
            'TRANSCRIPT_UNAVAILABLE',
            'private provider path',
            true,
          );
        }),
      },
    });
    const { response, body } = await getSnapshot(testFixture, `chatId=${CHAT_ID}`);

    expect(response.status).toBe(200);
    expect(body.processingPhase).toBe('running');
    expect(body.transcript).toEqual({
      availability: 'unavailable',
      errorCode: 'TRANSCRIPT_UNAVAILABLE',
      retryable: true,
      message: TRANSCRIPT_TEMPORARILY_UNAVAILABLE_MESSAGE,
    });
    expect(testFixture.pendingInputs.reconcileRetainedHistory).toHaveBeenCalled();
  });

  test('uses the standard error envelope for unexpected transcript failures', async () => {
    routeLogger.error.mockClear();
    const testFixture = fixture({
      chatViews: { getOrCreatePage: mock(async () => { throw new Error('private path'); }) },
    });
    const { response, body } = await getSnapshot(testFixture, `chatId=${CHAT_ID}`);

    expect(response.status).toBe(500);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(body).toMatchObject({
      error: 'Internal server error',
      errorCode: 'INTERNAL_ERROR',
      retryable: true,
    });
    expect(JSON.stringify(body)).not.toContain('private path');
    expect(routeLogger.error).toHaveBeenCalledTimes(1);
    expect(routeLogger.error.mock.calls[0]?.[0]).toBe(
      `snapshot failed for chat ${CHAT_ID}:`,
    );
    expect(routeLogger.error.mock.calls[0]?.[1]).toBeInstanceOf(Error);
  });
});
