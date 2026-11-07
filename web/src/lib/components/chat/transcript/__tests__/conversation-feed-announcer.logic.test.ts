import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AssistantMessage, BashToolUseMessage, CliRowMessage, CommandOutputMessage, CommandResultMessage,
	ExternalToolUseMessage, McpToolUseMessage, PermissionRequestMessage, ToolResultMessage, UnknownToolUseMessage, UserMessage, WaitToolUseMessage,
	type ChatMessage } from '$shared/chat-types';
import { emptyResponseClassOrdinals, type ResponseClassOrdinals } from '$shared/transcript-display-events';
import type { ChatDisplayRow } from '$lib/chat/transcript/transcript-row-projection.js';
import { CHAT_FEED_ANNOUNCEMENT_BATCH_MS, ConversationFeedAnnouncementBatcher, ConversationFeedAnnouncerState,
	announcementForAppendedRow, plainAnnouncementText } from '../conversation-feed-announcer.js';

const row = (ordinal: number, message: ChatMessage): ChatDisplayRow => ({ kind: 'message', id: `view:${ordinal}`, ordinal, message });
const assistant = (ordinal: number, text: string) => row(ordinal, new AssistantMessage('', text));
const permission = (ordinal: number, id = 'permission-1') => row(ordinal, new PermissionRequestMessage('', id, new BashToolUseMessage('', 'tool-1', 'true')));
const responses = (values: Partial<ResponseClassOrdinals> = {}): ResponseClassOrdinals => ({ ...emptyResponseClassOrdinals(), ...values });
function input(overrides: Partial<Parameters<ConversationFeedAnnouncerState['reconcile']>[0]> = {}) {
	return { surfaceIdentity: 'chat:view', rows: [assistant(1, 'Existing')], watermark: 1, initialHead: 1, sourceHead: 1,
		responseClassOrdinals: responses({ assistant: 1 }), visible: true, pinnedToBottom: true,
		detachedStatus: 'New response available', floatingPermissionOccurrences: [], ...overrides };
}
function initialized() {
	const announcer = new ConversationFeedAnnouncerState();
	expect(announcer.reconcile(input())).toBe('');
	return announcer;
}

describe('certified feed announcements', () => {
	it.each([false, true])('does not consume future permission lineage before it can be announced, floating=%s', floating => {
		const announcer = initialized();
		const future = input({ rows: [permission(2)], sourceHead: 2 });
		expect(announcer.reconcile(future)).toBeNull();
		expect(announcer.reconcile({ ...future, watermark: floating ? 1 : 2,
			floatingPermissionOccurrences: floating ? ['permission-1'] : [] })).toBe('Permission required');
		expect(announcer.reconcile({ ...future, watermark: 2, floatingPermissionOccurrences: ['permission-1'] })).toBeNull();
	});
	it('announces newly accepted rows, not descriptor refreshes or historical member hydration', () => {
		const announcer = initialized();
		const next = input({ rows: [assistant(1, 'Existing'), assistant(2, '**New** response')], watermark: 2, sourceHead: 2,
			responseClassOrdinals: responses({ assistant: 2 }) });
		expect(announcer.reconcile(next)).toBe('New response');
		expect(announcer.reconcile(next)).toBeNull();
		expect(announcer.reconcile({ ...next, rows: [row(1, new BashToolUseMessage('', 'tool-1', 'true')), ...next.rows] })).toBeNull();
	});

	it('waits for hydration after a live head notification', () => {
		const announcer = initialized();
		const head = input({ sourceHead: 2, responseClassOrdinals: responses({ assistant: 2 }) });
		expect(announcer.reconcile(head)).toBeNull();
		expect(announcer.reconcile({ ...head, watermark: 2, rows: [assistant(2, 'Prepared response')] })).toBe('Prepared response');
	});

	it('does not announce filtered or collapsed member bodies merely because the head advances', () => {
		const announcer = initialized();
		const head = input({ sourceHead: 1000, watermark: 1000, responseClassOrdinals: responses({ tool: 999 }) });
		expect(announcer.reconcile(head)).toBeNull();
		expect(announcer.reconcile({ ...head, rows: [row(500, new BashToolUseMessage('', 'tool-1', 'true'))] })).toBeNull();
	});

	it('reports detached progress once without speaking subsequent catch-up bodies', () => {
		const announcer = initialized();
		const detached = input({ pinnedToBottom: false, sourceHead: 2, responseClassOrdinals: responses({ assistant: 2 }) });
		expect(announcer.reconcile(detached)).toBe('New response available');
		expect(announcer.reconcile({ ...detached, sourceHead: 3, responseClassOrdinals: responses({ assistant: 3 }) })).toBeNull();
		expect(announcer.reconcile({ ...detached, pinnedToBottom: true, sourceHead: 3, watermark: 3, rows: [assistant(3, 'Already notified')] })).toBe('');
	});

	it('consumes head progress while hidden even when the index has not hydrated it', () => {
		const announcer = initialized();
		const hidden = input({ visible: false, sourceHead: 5, responseClassOrdinals: responses({ assistant: 5 }) });
		expect(announcer.reconcile(hidden)).toBe('');
		expect(announcer.reconcile({ ...hidden, visible: true })).toBeNull();
		expect(announcer.reconcile({ ...hidden, visible: true, watermark: 5, rows: [assistant(5, 'Hidden response')] })).toBeNull();
		expect(announcer.reconcile(input({ sourceHead: 6, watermark: 6, rows: [assistant(6, 'Visible response')], responseClassOrdinals: responses({ assistant: 6 }) }))).toBe('Visible response');
	});

	it('suppresses cold activation and reconnect history through the admitted open head', () => {
		const announcer = initialized();
		const opening = input({ initialHead: 100, sourceHead: 100, responseClassOrdinals: responses({ assistant: 99 }) });
		expect(announcer.reconcile(opening)).toBeNull();
		expect(announcer.reconcile({ ...opening, watermark: 100, rows: [assistant(99, 'Historical')] })).toBeNull();
	});

	it('resets announcement identity on chat and view changes', () => {
		const announcer = initialized();
		expect(announcer.reconcile(input({ sourceHead: 50, watermark: 50, rows: [assistant(50, 'First chat')] }))).toBe('First chat');
		expect(announcer.reconcile(input({ surfaceIdentity: 'different:view' }))).toBe('');
		expect(announcer.reconcile(input({ surfaceIdentity: 'different:view', sourceHead: 2, watermark: 2, rows: [assistant(2, 'Second chat')] }))).toBe('Second chat');
	});

	it.each([true, false])('does not repeat optimistic input after its durable echo (visible=%s)', visible => {
		const announcer = initialized();
		const message = new UserMessage('', 'Send once', undefined, { clientMessageId: 'input-1' });
		const pending: ChatDisplayRow = { kind: 'message', id: 'optimistic:input-1', message };
		expect(announcer.reconcile(input({ rows: [pending], visible }))).toBe(visible ? 'Send once' : '');
		expect(announcer.reconcile(input({ rows: [pending] }))).toBeNull();
		expect(announcer.reconcile(input({ rows: [row(2, message)], watermark: 2, sourceHead: 2 }))).toBeNull();
	});

	it.each([true, false])('does not repeat a floating permission after durable hydration (visible=%s)', visible => {
		const announcer = initialized();
		expect(announcer.reconcile(input({ floatingPermissionOccurrences: ['permission-1'], visible }))).toBe(visible ? 'Permission required' : '');
		expect(announcer.reconcile(input({ rows: [permission(2)], watermark: 2, sourceHead: 2 }))).toBeNull();
		expect(announcer.reconcile(input({ rows: [permission(3, 'permission-2')], watermark: 3, sourceHead: 3 }))).toBe('Permission required');
	});

	it('deduplicates a capability that appears in the same projection as its durable request', () => {
		const announcer = initialized();
		expect(announcer.reconcile(input({ rows: [permission(2)], watermark: 2, sourceHead: 2, floatingPermissionOccurrences: ['permission-1'] }))).toBe('Permission required');
	});

	it('retains active permission lineage when older history exceeds its bounded cache', () => {
		const announcer = initialized();
		announcer.reconcile(input({ floatingPermissionOccurrences: ['permission-1'] }));
		const rows = Array.from({ length: 513 }, (_, index) => permission(index + 2, `historical-${index}`));
		announcer.reconcile(input({ rows, watermark: 514, sourceHead: 514, floatingPermissionOccurrences: ['permission-1'], visible: false }));
		expect(announcer.reconcile(input({ rows: [...rows, permission(515)], watermark: 515, sourceHead: 515 }))).toBeNull();
	});

	it('announces local notices without requiring a new canonical watermark', () => {
		const announcer = initialized();
		const notice: ChatDisplayRow = { kind: 'local-notice', id: 'notice-1', noticeType: 'info', content: '**Working**', timestamp: '' };
		expect(announcer.reconcile(input({ rows: [notice] }))).toBe('Working');
		expect(announcer.reconcile(input({ rows: [] }))).toBeNull();
		expect(announcer.reconcile(input({ rows: [notice] }))).toBeNull();
	});

	it('preserves literal command punctuation and CLI presentation semantics', () => {
		const output = new CommandOutputMessage('', 'command', 'stdout', 'plain', 'file_name **literal**', null);
		expect(announcementForAppendedRow(row(1, output))).toBe('file_name **literal**');
		expect(announcementForAppendedRow(row(1, new UserMessage('', 'file_name', undefined, { contentMode: 'literal' })))).toBe('file_name');
		expect(announcementForAppendedRow(row(1, new UserMessage('', '**Complete**', undefined, undefined, { origin: 'cli', style: 'info', title: 'Status' })))).toBe('CLI info: Status. Complete');
		expect(announcementForAppendedRow(row(1, new CliRowMessage('', '**Complete**', { style: 'notice' }, 'markdown', 'Deploy')))).toBe('CLI notice: Deploy. Complete');
	});

	it('keeps private tool labels and intrinsically silent results out of speech', () => {
		const messages = [new UnknownToolUseMessage('', 'tool', 'private_name', {}), new ExternalToolUseMessage('', 'tool', 'private_name', {}, 'provider'),
			new McpToolUseMessage('', 'tool', 'server', 'private_tool', {}), new WaitToolUseMessage('', 'tool', 'execution'), new ToolResultMessage('', 'tool', {}, false),
			new CommandResultMessage('', 'command', { outcome: 'finished', exitCode: 0, signal: null, capture: 'complete', cwd: { kind: 'reported', path: '/workspace' } })];
		for (const message of messages) expect(announcementForAppendedRow(row(1, message))).toBeNull();
		expect(announcementForAppendedRow(row(1, new BashToolUseMessage('', 'tool', 'true')))).toBe('Bash');
	});

	it('flattens Markdown, links, and code blocks without punctuation noise', () => {
		expect(plainAnnouncementText('## See [the file](/workspace/file) and `value`')).toBe('See the file and value');
		expect(plainAnnouncementText('Before\n```ts\nconst value = 1;\n```\nafter')).toBe('Before Code block after');
	});
});

describe('ConversationFeedAnnouncementBatcher', () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());
	it('batches rapid discrete announcements on the original deadline', () => {
		const publish = vi.fn<(text: string) => void>();
		const batcher = new ConversationFeedAnnouncementBatcher(publish);
		batcher.enqueue({ kind: 'announce', chunks: ['First response'] });
		vi.advanceTimersByTime(100);
		batcher.enqueue({ kind: 'announce', chunks: ['Second response'] });
		expect(publish).not.toHaveBeenCalled();
		vi.advanceTimersByTime(CHAT_FEED_ANNOUNCEMENT_BATCH_MS - 100);
		expect(publish).toHaveBeenCalledExactlyOnceWith('First response\nSecond response');
		batcher.destroy();
	});
	it('keeps distinct rows and commands separate', () => {
		const publish = vi.fn<(text: string) => void>();
		const batcher = new ConversationFeedAnnouncementBatcher(publish);
		batcher.enqueue({ kind: 'announce', chunks: ['First response', 'Permission required', 'Second response'] });
		vi.advanceTimersByTime(CHAT_FEED_ANNOUNCEMENT_BATCH_MS);
		expect(publish).toHaveBeenCalledWith('First response\nPermission required\nSecond response');
		batcher.destroy();
	});
	it('cancels pending speech when hidden or destroyed', () => {
		const publish = vi.fn<(text: string) => void>();
		const batcher = new ConversationFeedAnnouncementBatcher(publish);
		const update = { kind: 'announce' as const, chunks: ['Stale'] };
		batcher.enqueue(update);
		batcher.enqueue({ kind: 'clear' });
		vi.advanceTimersByTime(CHAT_FEED_ANNOUNCEMENT_BATCH_MS);
		expect(publish).toHaveBeenCalledExactlyOnceWith('');
		batcher.enqueue(update);
		batcher.destroy();
		vi.advanceTimersByTime(CHAT_FEED_ANNOUNCEMENT_BATCH_MS);
		expect(publish).toHaveBeenCalledOnce();
	});
});
