import { describe, expect, it } from 'bun:test';
import { AssistantMessage, UserMessage, ThinkingMessage, ErrorMessage, TranscriptNoticeMessage, BashToolUseMessage, ToolResultMessage, WaitToolUseMessage, CommandResultMessage, EnterPlanModeToolUseMessage } from '../chat-types.js';
import { ChatInputCommittedMessage, ChatTranscriptHeadUpdatedMessage, ChatDisplayStateUpdatedMessage, transcriptActivity } from '../transcript-display-events.js';
import { parseServerWsMessage } from '../ws-events.js';
import { parseClientWsMessage } from '../ws-requests.js';

describe('compact transcript events', () => {
	it('separates live plan entry and announceable categories from coarse response facts', () => {
		const messages = [new BashToolUseMessage('', 'tool-1', 'true'), new ThinkingMessage('', 'Synthetic thinking'),
			new WaitToolUseMessage('', 'tool-2', 'execution'), new CommandResultMessage('', 'command',
				{ outcome: 'finished', exitCode: 0, signal: null, capture: 'complete', cwd: { kind: 'reported', path: '/workspace' } }),
			new EnterPlanModeToolUseMessage('', 'tool-3')];
		const facts = transcriptActivity(messages.map((message, index) => ({ ordinal: index + 1, message })));
		expect(facts.announcementOrdinals).toMatchObject({ bash: 1, thinking: 2, exec: 0, 'command-result': 0, tool: 0 });
		expect(facts.livePlanEnterOrdinal).toBe(5);
		expect(transcriptActivity([]).livePlanEnterOrdinal).toBeNull();
	});
  it.each([
    ['first\nsecond\nthird', 'first'],
    ['single line', 'single line'],
    ['  padded  \nmore', 'padded'],
    ['', ''],
    ['a'.repeat(300), 'a'.repeat(200)],
  ])('uses a bounded first-line preview for %j', (content, preview) => {
    const at = '2026-01-01T00:00:00.000Z';
    const facts = transcriptActivity([{ ordinal: 1, message: new AssistantMessage(at, content) }]);
    expect(facts.preview).toEqual({ ordinal: 1, text: preview, timestamp: at });
  });
  it('keeps non-conversational activity out of previews', () => {
    const at = '2026-01-01T00:00:00.000Z';
    const rows = [new BashToolUseMessage(at, 'tool', 'true'), new ToolResultMessage(at, 'tool', {}, false),
      new TranscriptNoticeMessage(at, 'notice'), new ErrorMessage(at, 'error'), new ThinkingMessage(at, 'thinking')]
      .map((message, index) => ({ ordinal: index + 2, message }));
    expect(transcriptActivity(rows).preview).toBeNull();
    expect(transcriptActivity([]).preview).toBeNull();
    expect(transcriptActivity([{ ordinal: 1, message: new UserMessage(at, 'prompt') }, ...rows]).preview)
      .toEqual({ ordinal: 1, text: 'prompt', timestamp: at });
  });
  it('round-trips body-free facts and bounds response watermarks and previews', () => {
    const at = '2026-01-01T00:00:00.000Z';
    const facts = transcriptActivity([{ ordinal: 1, message: new UserMessage(at, 'prompt') },
      { ordinal: 3, message: new AssistantMessage(at, ' answer\nrest') }]);
    const head = new ChatTranscriptHeadUpdatedMessage('server', 'chat', 'view', 4, facts.presentedActivityAt,
      facts.preview, facts.responseClassOrdinals, 0, 4, facts.announcementOrdinals, facts.livePlanEnterOrdinal);
    for (const message of [head, new ChatInputCommittedMessage('server', 'chat', 'view', 'input', 1),
      new ChatDisplayStateUpdatedMessage('server', 'chat', 'view', 1, 'revision', 4, 'available', null)]) {
      expect(parseServerWsMessage(JSON.parse(JSON.stringify(message)))).toEqual(message);
    }
    expect(head.preview?.text).toBe('answer');
    expect(parseServerWsMessage({ ...head, responseClassOrdinals: { ...head.responseClassOrdinals, tool: 5 } })).toBeNull();
    expect(parseServerWsMessage({ ...head, preview: { ...head.preview, text: 'x'.repeat(201) } })).toBeNull();
    expect(parseServerWsMessage({ ...head, sourceHead: Number.MAX_SAFE_INTEGER + 1 })).toBeNull();
    expect(parseServerWsMessage({ ...head, announcementOrdinals: undefined })).toBeNull();
    expect(parseServerWsMessage({ ...head, announcementOrdinals: { ...head.announcementOrdinals, bash: 5 } })).toBeNull();
    expect(parseServerWsMessage({ ...head, announcementOrdinals: { ...head.announcementOrdinals, thinking: -1 } })).toBeNull();
    for (const livePlanEnterOrdinal of [undefined, 0, 5, '1']) {
      expect(parseServerWsMessage({ ...head, livePlanEnterOrdinal })).toBeNull();
    }
    expect(parseServerWsMessage({ ...head, livePlanEnterOrdinal: 4 })?.livePlanEnterOrdinal).toBe(4);
  });
  it('separates presented activity from response and preview selection', () => {
    const facts = transcriptActivity([{ ordinal: 8, message: new ThinkingMessage('2026-01-02T00:00:00.000Z', 'reasoning') },
      { ordinal: 9, message: new AssistantMessage('2026-01-01T00:00:00.000Z', 'reply') }]);
    expect(facts.presentedActivityAt).toBe('2026-01-02T00:00:00.000Z');
    expect(facts.preview?.ordinal).toBe(9);
    expect(facts.responseClassOrdinals).toMatchObject({ assistant: 9, thinking: 8 });
    expect(transcriptActivity([]).presentedActivityAt).toBeNull();
  });
  it('[TLV5-DISPLAY.07-CONTRACT-01] rejects the retired browser body and replay protocols', () => {
    expect(parseServerWsMessage({ type: 'chat-messages' })).toBeNull();
    expect(parseClientWsMessage({ type: 'chat-subscribe', clientRequestId: 'request', chatId: 'chat', transcriptViewId: 'view', afterOrdinal: 0 })).toBeNull();
    expect(parseServerWsMessage({ type: 'chat-subscribed', clientRequestId: 'request', chatId: 'chat', transcriptViewId: 'view',
      messages: [], firstOrdinal: 1, lastOrdinal: 0, nextAfterOrdinal: 0, throughOrdinal: 0, hasMore: false, resendCandidates: [],
      transientFeed: { serverInstanceId: 'server', chatId: 'chat', transcriptViewId: 'view', transientRevision: 0, rows: [] } })).toBeNull();
  });
});
