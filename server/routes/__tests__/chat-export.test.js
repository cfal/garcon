import { describe, expect, it, mock } from 'bun:test';
import { DomainError } from '../../lib/domain-error.ts';
import { isNoAuthHandler } from '../../lib/http-route.ts';
import { createChatExportRoutes } from '../chat-export.ts';

const CHAT_ID = '1787505989127000';

describe('chat export routes', () => {
  it('returns a non-cacheable authenticated export with canonical exclusions', async () => {
    const exportTranscript = mock(async (request) => response(request));
    const routes = createChatExportRoutes({ export: exportTranscript });
    const handler = routes['/api/v1/chats/export'].GET;
    const url = new URL(
      `http://localhost/api/v1/chats/export?chatId=${CHAT_ID}&format=xml&exclude=handoffs&exclude=tool-calls&exclude=tool-calls`,
    );

    const result = await handler(new Request(url), url);

    expect(isNoAuthHandler(handler)).toBe(false);
    expect(result.status).toBe(200);
    expect(result.headers.get('Cache-Control')).toBe('no-store');
    expect(exportTranscript).toHaveBeenCalledWith({
      chatId: CHAT_ID,
      format: 'xml',
      exclusions: ['tool-calls', 'handoffs'],
    }, expect.any(AbortSignal));
    expect(await result.json()).toMatchObject({ success: true, format: 'xml' });
  });

  it('defaults to Markdown with no exclusions', async () => {
    const exportTranscript = mock(async (request) => response(request));
    const routes = createChatExportRoutes({ export: exportTranscript });
    const url = new URL(`http://localhost/api/v1/chats/export?chatId=${CHAT_ID}`);

    const result = await routes['/api/v1/chats/export'].GET(new Request(url), url);

    expect(result.status).toBe(200);
    expect(exportTranscript).toHaveBeenCalledWith({
      chatId: CHAT_ID,
      format: 'markdown',
      exclusions: [],
    }, expect.any(AbortSignal));
  });

  it('rejects malformed query parameters before invoking the service', async () => {
    const exportTranscript = mock(async () => response({}));
    const routes = createChatExportRoutes({ export: exportTranscript });
    const queries = [
      '',
      '?chatId=bad',
      `?chatId=${CHAT_ID}&chatId=${CHAT_ID}`,
      `?chatId=${CHAT_ID}&format=json`,
      `?chatId=${CHAT_ID}&format=xml&format=markdown`,
      `?chatId=${CHAT_ID}&exclude=tools`,
      `?chatId=${CHAT_ID}&exclude=tool-calls,tool-results`,
      `?chatId=${CHAT_ID}&exclude=`,
    ];

    for (const query of queries) {
      const url = new URL(`http://localhost/api/v1/chats/export${query}`);
      const result = await routes['/api/v1/chats/export'].GET(new Request(url), url);
      expect(result.status).toBe(400);
      expect(result.headers.get('Cache-Control')).toBe('no-store');
      expect(await result.json()).toMatchObject({
        success: false,
        errorCode: 'VALIDATION_FAILED',
        retryable: false,
      });
    }
    expect(exportTranscript).not.toHaveBeenCalled();
  });

  it('preserves typed service failures for missing, raced, and unavailable transcripts', async () => {
    for (const failure of [
      new DomainError('SESSION_NOT_FOUND', 'Session not found', 404, false),
      new DomainError('SOURCE_REVISION_CHANGED', 'View changed', 409, true),
      new DomainError('TRANSCRIPT_UNAVAILABLE', 'Transcript unavailable', 422, false),
    ]) {
      const routes = createChatExportRoutes({ export: async () => { throw failure; } });
      const url = new URL(`http://localhost/api/v1/chats/export?chatId=${CHAT_ID}`);
      const result = await routes['/api/v1/chats/export'].GET(new Request(url), url);
      expect(result.status).toBe(failure.status);
      expect(await result.json()).toMatchObject({
        success: false,
        errorCode: failure.code,
        retryable: failure.retryable,
      });
    }
  });
});

function response(request) {
  return {
    success: true,
    chatId: request.chatId ?? CHAT_ID,
    format: request.format ?? 'markdown',
    transcriptViewId: 'view-1',
    lastOrdinal: 0,
    generatedAt: '2026-08-23T00:00:00.000Z',
    entryCount: 0,
    totalEntryCount: 0,
    exclusions: request.exclusions ?? [],
    omitted: [],
    document: '# Empty\n',
  };
}
