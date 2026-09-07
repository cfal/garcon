import { describe, expect, it, mock } from 'bun:test';
import { DomainError } from '../../lib/domain-error.ts';
import { isNoAuthHandler } from '../../lib/http-route.ts';
import { createChatHandoffArtifactRoutes } from '../chat-handoff-artifact.ts';

const CHAT_ID = '1787505989127000';
const PATH = '/api/v1/chats/handoff-artifact';

describe('chat handoff artifact routes', () => {
  it('returns one authenticated non-cacheable read-only artifact', async () => {
    const create = mock(async (request) => response(request));
    const routes = createChatHandoffArtifactRoutes({ create });
    const handler = routes[PATH].GET;
    const url = new URL(
      `http://localhost${PATH}?chatId=${CHAT_ID}&contextWindowTokens=131072`,
    );

    const result = await handler(new Request(url), url);

    expect(isNoAuthHandler(handler)).toBe(false);
    expect(result.status).toBe(200);
    expect(result.headers.get('Cache-Control')).toBe('no-store');
    expect(create).toHaveBeenCalledWith({
      chatId: CHAT_ID,
      contextWindowTokens: 131_072,
    }, expect.any(AbortSignal));
    expect(await result.json()).toMatchObject({
      success: true,
      chatId: CHAT_ID,
      contextWindowTokens: 131_072,
    });
  });

  it('rejects malformed parameters before invoking the service', async () => {
    const create = mock(async (request) => response(request));
    const routes = createChatHandoffArtifactRoutes({ create });
    const queries = [
      '',
      '?chatId=bad&contextWindowTokens=500000',
      `?chatId=${CHAT_ID}&chatId=${CHAT_ID}&contextWindowTokens=500000`,
      `?chatId=${CHAT_ID}`,
      `?chatId=${CHAT_ID}&contextWindowTokens=`,
      `?chatId=${CHAT_ID}&contextWindowTokens=500000&contextWindowTokens=200000`,
      `?chatId=${CHAT_ID}&contextWindowTokens=1.5`,
      `?chatId=${CHAT_ID}&contextWindowTokens=1e5`,
      `?chatId=${CHAT_ID}&contextWindowTokens=200k`,
      `?chatId=${CHAT_ID}&contextWindowTokens=1023`,
      `?chatId=${CHAT_ID}&contextWindowTokens=10000001`,
    ];

    for (const query of queries) {
      const url = new URL(`http://localhost${PATH}${query}`);
      const result = await routes[PATH].GET(new Request(url), url);
      expect(result.status).toBe(400);
      expect(result.headers.get('Cache-Control')).toBe('no-store');
      expect(await result.json()).toMatchObject({
        success: false,
        errorCode: 'VALIDATION_FAILED',
        retryable: false,
      });
    }
    expect(create).not.toHaveBeenCalled();
  });

  it('preserves typed service failures with no-store caching', async () => {
    for (const failure of [
      new DomainError('SESSION_NOT_FOUND', 'Session not found', 404, false),
      new DomainError('SOURCE_REVISION_CHANGED', 'View changed', 409, true),
    ]) {
      const routes = createChatHandoffArtifactRoutes({
        create: async () => { throw failure; },
      });
      const url = new URL(
        `http://localhost${PATH}?chatId=${CHAT_ID}&contextWindowTokens=500000`,
      );
      const result = await routes[PATH].GET(new Request(url), url);
      expect(result.status).toBe(failure.status);
      expect(result.headers.get('Cache-Control')).toBe('no-store');
      expect(await result.json()).toMatchObject({
        success: false,
        errorCode: failure.code,
        retryable: failure.retryable,
      });
    }
  });
});

function response(request) {
  const document = '<handoff-artifact/>\n';
  return {
    success: true,
    chatId: request.chatId,
    transcriptViewId: 'view-1',
    lastOrdinal: 0,
    generatedAt: '2026-08-26T00:00:00.000Z',
    contextWindowTokens: request.contextWindowTokens,
    usableTokenBudget: Math.floor(request.contextWindowTokens * 3 / 4),
    estimatedTokens: 10,
    fold: 'handoff-v1',
    gapUnit: 'eligible-entry',
    sourceEntryCount: 0,
    eligibleEntryCount: 0,
    excludedEntryCounts: [],
    includedEntryCount: 0,
    budgetOmittedEntryCount: 0,
    abridgedEntryCount: 0,
    gapCount: 0,
    projectionTruncated: false,
    documentCodeUnits: document.length,
    document,
  };
}
