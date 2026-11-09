import { describe, expect, it, mock, spyOn } from 'bun:test';
import { AssistantMessage, BashToolUseMessage } from '../../../../common/chat-types.ts';
import { isErrorCode } from '../../../../common/error-codes.ts';
import { parseTranscriptAnchorResponse } from '../../../../common/transcript-anchor-page.ts';
import { DomainError } from '../../../common/domain-error.ts';
import { TranscriptHistoryUnavailableError } from '../../chats/errors.ts';
import { LedgerBulkOperationAbandonedError, LedgerFencedError, StaleTranscriptViewError } from '../../ledger/errors.ts';
import { NativeActivityAnchorPageReader } from '../../ledger/native-activity-page-reader.ts';
import { createCombinedMessageRoutes } from '../combined-messages.ts';

const input = { chatId: 'synthetic-chat', direction: 'backward', anchorsRemaining: 1 };
const rawPage = { transcriptViewId: 'synthetic-view', direction: 'backward',
  watermarkOrdinal: 4, lastOrdinal: 4, startOrdinal: 2, endOrdinal: 5,
  anchorsRemaining: 0, pageStatus: 'complete', messages: [{ ordinal: 4,
    message: new AssistantMessage('2026-01-01T00:00:00.000Z', 'Synthetic response') }] };

function fixture() {
  const reader = { anchorPage: mock(async () => rawPage) };
  const registry = { getChat: mock(() => ({})) };
  const processing = { phase: mock(() => null) };
  const resendCandidates = mock(() => [{ ordinal: 1, content: 'Synthetic input', attachmentNames: [] }]);
  const routes = createCombinedMessageRoutes({ reader, registry, processing, resendCandidates });
  const url = new URL('http://localhost/api/v1/chats/combined-messages');
  const call = (body = input, signal) => {
    const request = new Request(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal });
    return routes[url.pathname].POST(request, url);
  };
  return { reader, registry, processing, resendCandidates, call };
}

describe('POST /api/v1/chats/combined-messages', () => {
  it('serializes a complete interval wider than the former row and payload limits', async () => {
    const { call, reader } = fixture();
    const messages = Array.from({ length: 650 }, (_, i) => ({ ordinal: i + 2,
      message: new BashToolUseMessage('2026-01-01T00:00:00.000Z', `tool-${i}`, 'x'.repeat(2000)) }));
    messages.push({ ordinal: 652, message: rawPage.messages[0].message });
    reader.anchorPage.mockResolvedValue({ ...rawPage, watermarkOrdinal: 652, lastOrdinal: 652, endOrdinal: 653, messages });
    const response = await call();
    const body = await response.text();
    expect(body.length).toBeGreaterThan(1024 * 1024);
    expect(parseTranscriptAnchorResponse(input, JSON.parse(body)).messages).toHaveLength(651);
  });

  it.each([
    ['delete', 404, 'SESSION_NOT_FOUND'],
    ['abort', 499, null],
    ['interrupt', 503, 'TRANSCRIPT_READ_INTERRUPTED'],
    ['shutdown', 503, 'SERVER_SHUTTING_DOWN'],
  ])('translates %s during a held read without returning a prefix', async (action, status, errorCode) => {
    const { call, reader, registry } = fixture();
    const entered = Promise.withResolvers();
    const held = Promise.withResolvers();
    reader.anchorPage.mockImplementation(() => { entered.resolve(); return held.promise; });
    const abort = new AbortController();
    const pending = call(input, abort.signal);
    await entered.promise;
    if (action === 'delete' || action === 'abort') registry.getChat.mockReturnValue(null);
    if (action === 'abort') abort.abort();
    held.reject(action === 'shutdown'
      ? new DomainError('SERVER_SHUTTING_DOWN', 'Server is shutting down', 503, true)
      : new LedgerBulkOperationAbandonedError(input.chatId));
    const response = await pending;
    expect(response.status).toBe(status);
    if (errorCode !== null) {
      const body = await response.json();
      expect(body.errorCode).toBe(errorCode);
      expect(isErrorCode(body.errorCode)).toBe(true);
    }
  });

  it('discards a successful read after cancellation', async () => {
    const { call, reader, resendCandidates } = fixture();
    const abort = new AbortController();
    reader.anchorPage.mockImplementation(async () => {
      abort.abort();
      return rawPage;
    });
    expect((await call(input, abort.signal)).status).toBe(499);
    expect(resendCandidates).not.toHaveBeenCalled();
  });

  it('returns a typed anchor page without changing raw-page semantics', async () => {
    const { call, reader } = fixture();
    const response = await call();
    expect(response.status).toBe(200);
    expect(parseTranscriptAnchorResponse(input, await response.json())).toMatchObject({
      ...rawPage, chatId: input.chatId, historyState: { kind: 'complete' },
      resendCandidates: [{ ordinal: 1, content: 'Synthetic input', attachmentNames: [] }],
    });
    expect(reader.anchorPage).toHaveBeenCalledWith(input, expect.any(AbortSignal));
  });

  it('rejects malformed requests before reading', async () => {
    const { call, reader } = fixture();
    for (const body of [null, {}, { ...input, anchorsRemaining: 201 }, { ...input, cursorOrdinal: 3 }, { ...input, purpose: 'activation', direction: 'forward' }]) {
      const response = await call(body);
      expect(response.status).toBe(400);
      expect((await response.json()).errorCode).toBe('VALIDATION_FAILED');
    }
    expect(reader.anchorPage).not.toHaveBeenCalled();
  });

  it('checks chat existence both before admission and after the await', async () => {
    const { call, reader, registry } = fixture();
    registry.getChat.mockReturnValueOnce(null);
    expect((await call()).status).toBe(404);
    expect(reader.anchorPage).not.toHaveBeenCalled();
    reader.anchorPage.mockImplementation(async () => {
      registry.getChat.mockReturnValue(null);
      return rawPage;
    });
    expect((await call()).status).toBe(404);
  });

  it('reads resend candidates only for idle initial backward requests', async () => {
    const { call, processing, resendCandidates } = fixture();
    const continuation = { ...input, cursorOrdinal: 5, transcriptViewId: rawPage.transcriptViewId };
    expect((await (await call(continuation)).json()).resendCandidates).toEqual([]);
    expect((await (await call({ ...input, direction: 'forward' })).json()).resendCandidates).toEqual([]);
    processing.phase.mockReturnValue('running');
    expect((await (await call()).json()).resendCandidates).toEqual([]);
    expect(resendCandidates).not.toHaveBeenCalled();
  });

  it('preserves stale-view and cursor-ahead recovery errors', async () => {
    const { call, reader } = fixture();
    for (const [error, errorCode] of [
      [new StaleTranscriptViewError(input.chatId, 'old', 'new'), 'STALE_TRANSCRIPT_VIEW'],
      [new DomainError('TRANSCRIPT_CURSOR_AHEAD', 'Cursor ahead', 409), 'TRANSCRIPT_CURSOR_AHEAD'],
    ]) {
      reader.anchorPage.mockRejectedValueOnce(error);
      const response = await call();
      expect(response.status).toBe(409);
      expect((await response.json()).errorCode).toBe(errorCode);
    }
    const response = await call({ ...input, transcriptViewId: 'other-view' });
    expect(response.status).toBe(409);
  });

  it('preserves cancellation and degraded history instead of reporting exhaustion', async () => {
    const { call, reader } = fixture();
    reader.anchorPage.mockRejectedValueOnce(new TranscriptHistoryUnavailableError({ kind: 'degraded', errorCode: 'HISTORY_LOAD_FAILED', retryable: true }));
    const response = await call();
    expect(response.status).toBe(200);
    expect(parseTranscriptAnchorResponse(input, await response.json())).toEqual({
      chatId: input.chatId, messages: [], historyState: { kind: 'degraded', errorCode: 'HISTORY_LOAD_FAILED', retryable: true },
    });
    const abort = new AbortController();
    reader.anchorPage.mockImplementation(async (_input, signal) => {
      abort.abort();
      signal.throwIfAborted();
    });
    expect((await call(input, abort.signal)).status).toBe(499);
  });

  it('short-circuits fenced logging without disclosing the cause or chat identity', async () => {
    const { call, reader } = fixture();
    const cause = Object.assign(new Error('/synthetic-private-path/ledger.sqlite'), { name: 'SQLiteError', code: 'SQLITE_CORRUPT' });
    reader.anchorPage.mockRejectedValue(new TranscriptHistoryUnavailableError({ kind: 'degraded', errorCode: 'LEDGER_FENCED', retryable: false },
      { cause: new LedgerFencedError(input.chatId, { cause }) }));
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    const error = spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect((await call()).status).toBe(200);
      expect(warn).toHaveBeenCalledWith('[routes:chats]', 'Transcript ledger read is fenced.', { causeName: 'SQLiteError', causeCode: 'SQLITE_CORRUPT' });
      expect(error).not.toHaveBeenCalled();
      expect(JSON.stringify(warn.mock.calls)).not.toContain(input.chatId);
      expect(JSON.stringify(warn.mock.calls)).not.toContain('synthetic-private-path');
    } finally {
      warn.mockRestore();
      error.mockRestore();
    }
  });
});

describe('anchor activation advisory', () => {
  it('schedules only a successful initial newest activation, not continuations or failed reads', async () => {
    const held = Promise.withResolvers();
    const pages = { anchorPage: mock(() => held.promise) };
    const nativeActivity = { requestCheck: mock(() => {}) };
    const reader = new NativeActivityAnchorPageReader(pages, nativeActivity);
    const pending = reader.anchorPage({ ...input, purpose: 'activation' });
    await Promise.resolve();
    expect(nativeActivity.requestCheck).not.toHaveBeenCalled();
    held.resolve(rawPage);
    await pending;
    await Promise.resolve();
    expect(nativeActivity.requestCheck).toHaveBeenCalledTimes(1);
    expect(nativeActivity.requestCheck).toHaveBeenCalledWith(input.chatId, 'activation');
    for (const request of [input, { ...input, direction: 'forward' }, { ...input, cursorOrdinal: 3, transcriptViewId: 'synthetic-view' }]) {
      await reader.anchorPage(request);
    }
    pages.anchorPage.mockRejectedValueOnce(new Error('Synthetic unavailable read'));
    await expect(reader.anchorPage({ ...input, purpose: 'activation' })).rejects.toThrow();
    await Promise.resolve();
    expect(nativeActivity.requestCheck).toHaveBeenCalledTimes(1);
  });
});
