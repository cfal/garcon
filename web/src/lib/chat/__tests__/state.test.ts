import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatState } from '../state.svelte';
import { AssistantMessage, ErrorMessage, UserMessage, type ChatMessage } from '$shared/chat-types';
import type { ChatViewMessage } from '$shared/chat-view';
import type { PendingUserInput } from '$shared/pending-user-input';
import { getChatMessages } from '$lib/api/chats.js';
import type { ChatDisplayRow } from '../state.svelte';

vi.mock('$lib/api/chats.js', () => ({
	getChatMessages: vi.fn(),
}));

const TS = '2026-06-01T00:00:00.000Z';

function entry(seq: number, message: ChatMessage): ChatViewMessage {
	return { seq, message };
}

function user(content: string, metadata: Record<string, unknown> = {}) {
	return new UserMessage(TS, content, undefined, metadata);
}

function assistant(content: string) {
	return new AssistantMessage(TS, content);
}

function contentOf(message: ChatMessage): string {
	return 'content' in message ? String(message.content) : '';
}

function rowContentOf(row: ChatDisplayRow): string {
	return row.kind === 'local-notice' ? row.content : contentOf(row.message);
}

function page(overrides: Partial<{
	generationId: string;
	messages: ChatViewMessage[];
	lastSeq: number;
	pageOldestSeq: number;
	hasMore: boolean;
	pendingUserInputs: PendingUserInput[];
}> = {}) {
	const messages = overrides.messages ?? [entry(1, assistant('hello'))];
	return {
		generationId: overrides.generationId ?? 'generation-1',
		messages,
		lastSeq: overrides.lastSeq ?? messages.at(-1)?.seq ?? 0,
		pageOldestSeq: overrides.pageOldestSeq ?? messages[0]?.seq ?? 0,
		hasMore: overrides.hasMore ?? false,
		pendingUserInputs: overrides.pendingUserInputs ?? [],
	};
}

describe('ChatState', () => {
	beforeEach(() => {
		localStorage.clear();
		vi.mocked(getChatMessages).mockReset();
	});

	it('starts with an empty generation cursor', () => {
		const chat = new ChatState();

		expect(chat.getCursor()).toEqual({ generationId: '', lastSeq: 0 });
		expect(chat.chatMessages).toEqual([]);
	});

	it('applies same-generation messages by seq and ignores duplicates', () => {
		const chat = new ChatState();

		expect(chat.applyMessages('chat-1', 'generation-1', [
			entry(1, user('hello')),
			entry(2, assistant('hi')),
		])).toBe('applied');
		expect(chat.applyMessages('chat-1', 'generation-1', [
			entry(2, assistant('duplicate')),
			entry(3, assistant('next')),
		])).toBe('applied');

		expect(chat.chatMessages.map(contentOf)).toEqual(['hello', 'hi', 'next']);
		expect(chat.getCursor()).toEqual({ generationId: 'generation-1', lastSeq: 3 });
	});

	it('signals generation changes instead of merging across generations', () => {
		const chat = new ChatState();
		chat.applyMessages('chat-1', 'generation-1', [entry(1, user('old'))]);

		const result = chat.applyMessages('chat-1', 'generation-2', [entry(1, assistant('fresh'))]);

		expect(result).toBe('generation-changed');
		expect(chat.chatMessages).toEqual([]);
		expect(chat.getCursor()).toEqual({ generationId: 'generation-2', lastSeq: 0 });
	});

	it('renders local messages as transient display-only rows', () => {
		const chat = new ChatState();
		chat.applyMessages('chat-1', 'generation-1', [entry(1, user('server'))]);

		chat.appendLocalNotice('progress', 'local status');
		chat.appendLocalNotice('error', 'local error');

		expect(chat.chatMessages.map(contentOf)).toEqual(['server']);
		expect(chat.visibleRows.map(rowContentOf)).toEqual(['server', 'local status', 'local error']);
		expect(chat.visibleRows.at(-2)).toMatchObject({ kind: 'local-notice', noticeType: 'progress' });
		expect(chat.visibleRows.at(-1)).toMatchObject({ kind: 'local-notice', noticeType: 'error' });
	});

	it('clears transient local messages when new server messages apply', () => {
		const chat = new ChatState();
		chat.applyMessages('chat-1', 'generation-1', [entry(1, user('server'))]);
		chat.appendLocalNotice('progress', 'local status');
		chat.appendLocalNotice('error', 'local error');

		chat.applyMessages('chat-1', 'generation-1', [entry(2, assistant('next'))]);

		expect(chat.visibleRows.map(rowContentOf)).toEqual(['server', 'next']);
	});

	it('clears transient local messages when a pending user input is submitted', () => {
		const chat = new ChatState();
		chat.applyMessages('chat-1', 'generation-1', [entry(1, user('server'))]);
		chat.appendLocalNotice('warning', 'Chat interrupted by user.');
		const noticeBottomRowId = chat.bottomVisibleRowId;
		expect(chat.displayMessageCount).toBe(2);
		expect(noticeBottomRowId).toMatch(/^local_/);

		chat.upsertPendingUserInput({
			chatId: 'chat-1',
			clientRequestId: 'req-1',
			clientMessageId: 'msg-1',
			content: 'continue',
			createdAt: '2026-06-01T00:00:01.000Z',
			deliveryStatus: 'submitting',
		});

		expect(chat.visibleRows.map(rowContentOf)).toEqual(['server', 'continue']);
		expect(chat.displayMessageCount).toBe(2);
		expect(chat.bottomVisibleRowId).toBe('pending:req-1');
		expect(chat.bottomVisibleRowId).not.toBe(noticeBottomRowId);
	});

	it('keeps transient local messages when replay only overlaps existing server messages', () => {
		const chat = new ChatState();
		chat.applyMessages('chat-1', 'generation-1', [entry(1, user('server'))]);
		chat.appendLocalNotice('error', 'local error');

		chat.applyMessages('chat-1', 'generation-1', [entry(1, user('duplicate'))]);

		expect(chat.visibleRows.map(rowContentOf)).toEqual(['server', 'local error']);
	});

	it('detects same-generation gaps without advancing the cursor', () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const chat = new ChatState();
		chat.applyMessages('chat-1', 'generation-1', [entry(1, user('server'))]);

		const result = chat.applyMessages('chat-1', 'generation-1', [entry(3, assistant('later'))]);

		expect(result).toBe('gap-detected');
		expect(chat.chatMessages.map(contentOf)).toEqual(['server']);
		expect(chat.getCursor()).toEqual({ generationId: 'generation-1', lastSeq: 1 });
		expect(warn).toHaveBeenCalledWith(expect.stringContaining('expected=2 received=3'));
		warn.mockRestore();
	});

	it('clears transient local messages when a live batch changes generation', () => {
		const chat = new ChatState();
		chat.applyMessages('chat-1', 'generation-1', [entry(1, user('old'))]);
		chat.appendLocalNotice('error', 'local error');

		const result = chat.applyMessages('chat-1', 'generation-2', [entry(1, assistant('fresh'))]);

		expect(result).toBe('generation-changed');
		expect(chat.displayMessages).toEqual([]);
	});

	it('buffers live same-generation messages while a snapshot is loading', () => {
		const chat = new ChatState();
		const epoch = chat.beginSnapshotLoad();

		chat.applyMessages('chat-1', 'generation-1', [entry(2, assistant('live'))]);
		const result = chat.setFromPage('chat-1', page({
			generationId: 'generation-1',
			messages: [entry(1, user('history'))],
			lastSeq: 1,
		}), epoch);

		expect(result).toBe('applied');
		expect(chat.chatMessages.map(contentOf)).toEqual(['history', 'live']);
		expect(chat.getCursor()).toEqual({ generationId: 'generation-1', lastSeq: 2 });
	});

	it('surfaces buffered same-generation gaps during snapshot load', () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const chat = new ChatState();
		const epoch = chat.beginSnapshotLoad();

		chat.applyMessages('chat-1', 'generation-1', [entry(5, assistant('later'))]);
		const result = chat.setFromPage('chat-1', page({
			generationId: 'generation-1',
			messages: [
				entry(1, user('one')),
				entry(2, assistant('two')),
				entry(3, assistant('three')),
			],
			lastSeq: 3,
		}), epoch);

		expect(result).toBe('gap-detected');
		expect(chat.chatMessages.map(contentOf)).toEqual(['one', 'two', 'three']);
		expect(chat.getCursor()).toEqual({ generationId: 'generation-1', lastSeq: 3 });
		warn.mockRestore();
	});

	it('does not install a stale snapshot when buffered messages indicate a new generation', () => {
		const chat = new ChatState();
		chat.replaceGeneration('chat-1', 'current-generation', [entry(1, assistant('current'))], { lastSeq: 1 });
		const epoch = chat.beginSnapshotLoad();

		chat.applyMessages('chat-1', 'new-generation', [entry(1, assistant('new live'))]);
		const result = chat.setFromPage('chat-1', page({
			generationId: 'old-generation',
			messages: [entry(1, user('old page'))],
			lastSeq: 1,
		}), epoch);

		expect(result).toBe('generation-changed');
		expect(chat.chatMessages.map(contentOf)).toEqual(['current']);
		expect(chat.getCursor()).toEqual({ generationId: 'current-generation', lastSeq: 1 });
	});

	it('installs pending inputs from HTTP snapshots and hides them after durable echo', () => {
		const chat = new ChatState();
		const epoch = chat.beginSnapshotLoad();

		chat.setFromPage('chat-1', page({
			messages: [],
			lastSeq: 0,
			pendingUserInputs: [{
				chatId: 'chat-1',
				clientRequestId: 'req-1',
				content: 'pending',
				createdAt: TS,
				deliveryStatus: 'accepted',
			}],
		}), epoch);
		expect(chat.visiblePendingInputs).toHaveLength(1);
		expect(chat.displayMessages.map(contentOf)).toEqual(['pending']);

		chat.applyMessages('chat-1', 'generation-1', [
			entry(1, user('pending', { clientRequestId: 'req-1', deliveryStatus: 'accepted' })),
		]);

		expect(chat.visiblePendingInputs).toHaveLength(0);
		expect(chat.displayMessages.map(contentOf)).toEqual(['pending']);
	});

	it('clears pending overlays when a generation is replaced without snapshot pending inputs', () => {
		const chat = new ChatState();
		chat.setPendingUserInputs([{
			chatId: 'chat-1',
			clientRequestId: 'req-1',
			content: 'pending',
			createdAt: TS,
			deliveryStatus: 'accepted',
		}]);

		chat.replaceGeneration('chat-1', 'generation-2', [
			entry(1, assistant('native')),
			entry(2, new ErrorMessage(TS, 'The process died.')),
		], { lastSeq: 2 });

		expect(chat.pendingUserInputs).toEqual([]);
		expect(chat.chatMessages.map(contentOf)).toEqual(['native', 'The process died.']);
		expect(chat.chatMessages[1]).toBeInstanceOf(ErrorMessage);
	});

	it('persists and activates generation-scoped transcript windows', () => {
		const chat = new ChatState();
		chat.applyMessages('chat-1', 'generation-1', [
			entry(1, user('first')),
			entry(2, assistant('second')),
		]);
		chat.transcriptCache.flush();

		const restored = new ChatState();
		const result = restored.activateChat('chat-1');

		expect(result).toEqual({ count: 2, stale: false });
		expect(restored.getCursor()).toEqual({ generationId: 'generation-1', lastSeq: 2 });
		expect(restored.chatMessages.map(contentOf)).toEqual(['first', 'second']);
	});
});
