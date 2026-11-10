import { describe, expect, it } from 'bun:test';
import { AssistantMessage, BashToolUseMessage, UserMessage } from '../chat-types.ts';
import {
  parseTranscriptAnchorRequest,
  parseTranscriptAnchorResponse,
  transcriptAnchorContinuation,
  transcriptAnchorWindow,
} from '../transcript-anchor-page.ts';

const TS = '2026-01-01T00:00:00.000Z';
const request = { chatId: 'synthetic-chat', direction: 'backward', anchorsRemaining: 1 };
const page = {
  historyState: { kind: 'complete' },
  chatId: request.chatId,
  transcriptViewId: 'synthetic-view',
  direction: 'backward',
  watermarkOrdinal: 4,
  lastOrdinal: 4,
  startOrdinal: 2,
  endOrdinal: 5,
  anchorsRemaining: 0,
  pageStatus: 'complete',
  messages: [
    { ordinal: 2, message: new BashToolUseMessage(TS, 'synthetic-tool', 'true') },
    { ordinal: 4, message: new AssistantMessage(TS, 'Synthetic response') },
  ],
  resendCandidates: [],
};

describe('combined history request', () => {
  it('accepts fresh view-qualified cursors and zero-budget continuations', () => {
    expect(parseTranscriptAnchorRequest(request)).toEqual(request);
    const fresh = { ...request, transcriptViewId: page.transcriptViewId, cursorOrdinal: 3 };
    expect(parseTranscriptAnchorRequest(fresh)).toEqual(fresh);
    const continuation = { ...fresh, watermarkOrdinal: 4, anchorsRemaining: 0 };
    expect(parseTranscriptAnchorRequest(continuation)).toEqual(continuation);
  });

  it.each([
    null, [], {},
    { ...request, chatId: '' },
    { ...request, direction: 'later' },
    ...[-1, 0, 201, 0.5, Infinity, NaN, '1'].map(anchorsRemaining => ({ ...request, anchorsRemaining })),
    { ...request, cursorOrdinal: 3 },
    { ...request, cursorOrdinal: 0, transcriptViewId: 'view' },
    { ...request, cursorOrdinal: 0.5, transcriptViewId: 'view' },
    { ...request, watermarkOrdinal: 4 },
    { ...request, watermarkOrdinal: 4, transcriptViewId: 'view' },
    { ...request, watermarkOrdinal: 4, cursorOrdinal: 6, transcriptViewId: 'view' },
    { ...request, direction: 'forward', watermarkOrdinal: 4, cursorOrdinal: 5, transcriptViewId: 'view' },
    { ...request, purpose: 'background' },
    { ...request, purpose: 'activation', direction: 'forward' },
    { ...request, purpose: 'activation', cursorOrdinal: 3, transcriptViewId: 'view' },
  ].map(value => [value]))('rejects malformed request %#', value => {
    expect(() => parseTranscriptAnchorRequest(value)).toThrow('Invalid combined history request');
  });
});

describe('combined history response', () => {
  it('validates the excluded anchor boundary and converts raw coverage separately from visible rows', () => {
    const parsed = parseTranscriptAnchorResponse(request, JSON.parse(JSON.stringify(page)));
    expect(parsed).toEqual(page);
    expect(transcriptAnchorWindow(parsed)).toMatchObject({
      pageOldestOrdinal: 2, pageNewestOrdinal: 4, nextBeforeOrdinal: 2, hasMore: true,
    });
    expect(transcriptAnchorContinuation(parsed)).toBeNull();
  });

  it.each(['backward', 'forward'])('accepts empty history in %s direction', direction => {
    const empty = { ...page, direction, watermarkOrdinal: 0, lastOrdinal: 0,
      startOrdinal: 1, endOrdinal: 1, messages: [], anchorsRemaining: 1, pageStatus: 'exhausted' };
    expect(parseTranscriptAnchorResponse({ ...request, direction }, empty)).toEqual(empty);
    expect(transcriptAnchorWindow(empty)).toMatchObject({
      pageOldestOrdinal: 0, pageNewestOrdinal: 0, nextBeforeOrdinal: null, hasMore: false,
    });
  });

  it.each(['backward', 'forward'])('accepts zero-budget empty completion in %s direction', direction => {
    const input = { ...request, direction, transcriptViewId: page.transcriptViewId,
      cursorOrdinal: 2, watermarkOrdinal: 4, anchorsRemaining: 0 };
    const cursor = direction === 'backward' ? 2 : 3;
    const empty = { ...page, direction, startOrdinal: cursor, endOrdinal: cursor, messages: [] };
    expect(parseTranscriptAnchorResponse(input, empty)).toEqual(empty);
    expect(transcriptAnchorContinuation(empty)).toBeNull();
    expect(() => transcriptAnchorWindow(empty)).toThrow('Empty terminal');
  });

  it('accepts forward exhaustion at a fixed watermark below the observed head', () => {
    const input = { ...request, direction: 'forward', transcriptViewId: page.transcriptViewId,
      cursorOrdinal: 4, watermarkOrdinal: 4 };
    const empty = { ...page, direction: 'forward', startOrdinal: 5, endOrdinal: 5,
      messages: [], lastOrdinal: 6, anchorsRemaining: 1, pageStatus: 'exhausted' };
    expect(parseTranscriptAnchorResponse(input, empty)).toEqual(empty);
    expect(transcriptAnchorContinuation(empty)).toBeNull();
  });

  it('preserves zero-budget hidden-only partial continuation and its raw cursor', () => {
    const input = { ...request, transcriptViewId: page.transcriptViewId, cursorOrdinal: 5,
      watermarkOrdinal: 4, anchorsRemaining: 0 };
    const partial = { ...page, startOrdinal: 3, messages: [], lastOrdinal: 8, pageStatus: 'partial' };
    expect(parseTranscriptAnchorResponse(input, partial)).toEqual(partial);
    expect(transcriptAnchorWindow(partial)).toMatchObject({
      pageOldestOrdinal: 0, pageNewestOrdinal: 4, nextBeforeOrdinal: 3,
    });
    expect(transcriptAnchorContinuation(partial)).toEqual({ ...input, cursorOrdinal: 3 });
  });

  it('counts provider user messages as anchors', () => {
    const user = { ...page, messages: [{ ordinal: 4, message: new UserMessage(TS, 'Synthetic input') }] };
    expect(parseTranscriptAnchorResponse(request, user)).toEqual(user);
  });

  it.each(['backward', 'forward'])('accepts wide public and hidden intervals (%s)', direction => {
    const messages = Array.from({ length: 5000 }, (_, index) => ({
      ordinal: index + 1, message: new BashToolUseMessage(TS, `tool-${index}`, 'true'),
    }));
    const wide = { ...page, direction, startOrdinal: 1, endOrdinal: 5001,
      watermarkOrdinal: 5000, lastOrdinal: 5000, anchorsRemaining: 1, pageStatus: 'exhausted', messages };
    expect(parseTranscriptAnchorResponse({ ...request, direction }, wide)).toEqual(wide);
    expect(parseTranscriptAnchorResponse({ ...request, direction }, { ...wide, messages: [] }).messages).toEqual([]);
    expect(() => parseTranscriptAnchorResponse({ ...request, direction }, { ...wide, anchorsRemaining: 0 })).toThrow();
    expect(() => parseTranscriptAnchorResponse({ ...request, direction }, { ...wide, messages: messages.toReversed() })).toThrow();
  });

  it('accepts the formerly width-rejected sparse boundary interval', () => {
    const wide = { ...page, startOrdinal: 2, endOrdinal: 203, watermarkOrdinal: 202, lastOrdinal: 202 };
    expect(parseTranscriptAnchorResponse(request, wide)).toEqual(wide);
  });

  it.each([
    { chatId: 'other' }, { direction: 'forward' }, { transcriptViewId: '' },
    { watermarkOrdinal: 3 }, { lastOrdinal: 3 }, { startOrdinal: 0 },
    { startOrdinal: 6 }, { endOrdinal: 4 }, { anchorsRemaining: 1 },
    { pageStatus: 'exhausted' }, { pageStatus: 'unknown' },
    { startOrdinal: 1, pageStatus: 'complete' },
    { messages: [{ ordinal: 1, message: new AssistantMessage(TS, 'Outside span') }] },
    { messages: [{ ordinal: 5, message: new AssistantMessage(TS, 'Outside span') }] },
    { messages: [...page.messages].reverse() },
  ])('rejects invalid response relation %#', change => {
    expect(() => parseTranscriptAnchorResponse(request, { ...page, ...change })).toThrow();
  });

  it.each(['backward', 'forward'])('rejects impossible terminal statuses with otherwise valid budgets (%s)', direction => {
    const input = { ...request, direction, transcriptViewId: page.transcriptViewId,
      cursorOrdinal: direction === 'backward' ? 5 : 0, watermarkOrdinal: 4 };
    const partial = { ...page, direction, pageStatus: 'partial',
      startOrdinal: direction === 'backward' ? 2 : 1,
      endOrdinal: direction === 'backward' ? 5 : 4,
      messages: [], anchorsRemaining: 1 };
    expect(parseTranscriptAnchorResponse(input, partial)).toEqual(partial);
    expect(() => parseTranscriptAnchorResponse(input, { ...partial, pageStatus: 'complete' }))
      .toThrow('completion');
    expect(() => parseTranscriptAnchorResponse(input, { ...partial, pageStatus: 'exhausted' }))
      .toThrow('exhaustion');
    const edge = direction === 'backward' ? 5 : 1;
    expect(() => parseTranscriptAnchorResponse(input, { ...partial, startOrdinal: edge, endOrdinal: edge }))
      .toThrow('partial must make progress');
    expect(() => parseTranscriptAnchorResponse(input, { ...partial, lastOrdinal: 3 }))
      .toThrow('watermark');
  });

  it('validates forward partial continuation, contiguity and resend eligibility independently', () => {
    const input = { ...request, direction: 'forward', transcriptViewId: page.transcriptViewId,
      cursorOrdinal: 0, watermarkOrdinal: 4 };
    const partial = { ...page, direction: 'forward', pageStatus: 'partial',
      startOrdinal: 1, endOrdinal: 3, messages: [], anchorsRemaining: 1 };
    expect(parseTranscriptAnchorResponse(input, partial)).toEqual(partial);
    expect(transcriptAnchorContinuation(partial)).toEqual({ ...input, cursorOrdinal: 2 });
    expect(() => parseTranscriptAnchorResponse(input, { ...partial, startOrdinal: 2 }))
      .toThrow('cursor contiguity');
    expect(() => parseTranscriptAnchorResponse(input, { ...partial,
      resendCandidates: [{ ordinal: 1, content: 'Synthetic input', attachmentNames: [] }] }))
      .toThrow('resend candidates on continuation');
    expect(() => parseTranscriptAnchorResponse({ ...request, direction: 'forward',
      transcriptViewId: page.transcriptViewId }, { ...partial,
      resendCandidates: [{ ordinal: 1, content: 'Synthetic input', attachmentNames: [] }] }))
      .toThrow('resend candidates on continuation');
  });

  it('rejects stale view, changed continuation watermark, and continuation resend candidates', () => {
    const input = { ...request, transcriptViewId: page.transcriptViewId, cursorOrdinal: 5, watermarkOrdinal: 4 };
    for (const change of [
      { transcriptViewId: 'other' }, { watermarkOrdinal: 5, lastOrdinal: 5 },
      { resendCandidates: [{ ordinal: 1, content: 'Synthetic', attachmentNames: [] }] },
    ]) expect(() => parseTranscriptAnchorResponse(input, { ...page, ...change })).toThrow();
  });

  it('keeps unavailable history separate from exhausted history', () => {
    const unavailable = { chatId: request.chatId, historyState: { kind: 'degraded', errorCode: 'LEDGER_FENCED', retryable: false }, messages: [] };
    expect(parseTranscriptAnchorResponse(request, unavailable)).toEqual(unavailable);
    for (const field of ['pageStatus', 'lastOrdinal', 'startOrdinal', 'watermarkOrdinal', 'resendCandidates']) {
      expect(() => parseTranscriptAnchorResponse(request, { ...unavailable, [field]: 0 })).toThrow();
    }
  });
});
