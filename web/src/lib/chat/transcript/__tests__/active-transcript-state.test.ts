import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	ACTIVE_TRANSCRIPT_RETENTION_LIMIT,
	ActiveTranscriptState,
	INITIAL_VISIBLE_MESSAGES,
} from '../active-transcript-state.svelte.js';
import { ChatTranscriptCache } from '../chat-transcript-cache.svelte';
import { AssistantMessage, ErrorMessage, UserMessage, type ChatMessage } from '$shared/chat-types';
import type { ChatViewMessage } from '$shared/chat-view';
import type { PendingUserInput } from '$shared/pending-user-input';
import { getChatMessages } from '$lib/api/chats.js';
import type { ChatDisplayRow } from '../active-transcript-state.svelte.js';

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

function page(
	overrides: Partial<{
		generationId: string;
		messages: ChatViewMessage[];
		lastSeq: number;
		pageOldestSeq: number;
		hasMore: boolean;
		pendingUserInputs: PendingUserInput[];
	}> = {},
) {
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

function pendingInput(overrides: Partial<PendingUserInput> = {}): PendingUserInput {
	return {
		chatId: 'chat-1',
		clientRequestId: 'req-1',
		clientMessageId: 'msg-1',
		content: 'pending',
		createdAt: TS,
		deliveryStatus: 'accepted',
		...overrides,
	};
}

describe('ActiveTranscriptState', () => {
	beforeEach(() => {
		localStorage.clear();
		vi.mocked(getChatMessages).mockReset();
	});

	afterEach(() => vi.restoreAllMocks());

	it('starts with an empty generation cursor', () => {
		const chat = new ActiveTranscriptState();

		expect(chat.getCursor()).toEqual({ generationId: '', lastSeq: 0 });
		expect(chat.chatMessages).toEqual([]);
		expect(chat.feedMutationClock.dataRevision).toBe(0);
	});

	it('records applied feed mutations by provenance without counting duplicates', () => {
		const chat = new ActiveTranscriptState();

		chat.applyMessages('chat-1', 'generation-1', [entry(1, assistant('hello'))]);
		const liveRevision = chat.feedMutationClock.dataRevision;
		expect(chat.feedMutationClock.lastRevisionByKind['live-append']).toBe(liveRevision);
		expect(chat.feedMutationClock.lastResponseRevision).toBe(liveRevision);
		expect(chat.feedMutationClock.lastResponseRevisionByMessageType).toEqual({
			'assistant-message': liveRevision,
		});

		chat.applyMessages('chat-1', 'generation-1', [entry(1, assistant('duplicate'))]);
		expect(chat.feedMutationClock.dataRevision).toBe(liveRevision);
		chat.applyMessages('chat-1', 'generation-1', [entry(2, user('next prompt'))]);
		expect(chat.feedMutationClock.lastResponseRevision).toBe(liveRevision);
		expect(chat.feedMutationClock.lastResponseRevisionByMessageType).toEqual({
			'assistant-message': liveRevision,
		});

		chat.appendLocalNotice('warning', 'notice');
		expect(chat.feedMutationClock.lastRevisionByKind['presentation-structure']).toBe(
			chat.feedMutationClock.dataRevision,
		);

		chat.clearMessages();
		expect(chat.feedMutationClock.lastRevisionByKind.replacement).toBe(
			chat.feedMutationClock.dataRevision,
		);
	});

	it('applies same-generation messages by seq and ignores duplicates', () => {
		const chat = new ActiveTranscriptState();

		expect(
			chat.applyMessages('chat-1', 'generation-1', [
				entry(1, user('hello')),
				entry(2, assistant('hi')),
			]),
		).toBe('applied');
		expect(
			chat.applyMessages('chat-1', 'generation-1', [
				entry(2, assistant('duplicate')),
				entry(3, assistant('next')),
			]),
		).toBe('applied');

		expect(chat.chatMessages.map(contentOf)).toEqual(['hello', 'hi', 'next']);
		expect(chat.getCursor()).toEqual({ generationId: 'generation-1', lastSeq: 3 });
	});

	it('bounds a bottom-pinned live transcript to the recent message window', () => {
		const chat = new ActiveTranscriptState();
		const messageCount = ACTIVE_TRANSCRIPT_RETENTION_LIMIT + 51;

		chat.applyMessages(
			'chat-1',
			'generation-1',
			Array.from({ length: messageCount }, (_, index) =>
				entry(index + 1, assistant(`message-${index + 1}`)),
			),
		);

		expect(chat.chatMessages).toHaveLength(ACTIVE_TRANSCRIPT_RETENTION_LIMIT);
		expect(contentOf(chat.chatMessages[0])).toBe('message-52');
		expect(chat.getCursor()).toEqual({ generationId: 'generation-1', lastSeq: messageCount });
		expect(chat.oldestSeq).toBe(52);
		expect(chat.hasEarlierMessages).toBe(true);
		expect(chat.visibleRows).toHaveLength(INITIAL_VISIBLE_MESSAGES);
	});

	it('preserves expanded history until it is explicitly compacted at the live edge', () => {
		const chat = new ActiveTranscriptState();
		const initial = Array.from({ length: ACTIVE_TRANSCRIPT_RETENTION_LIMIT }, (_, index) =>
			entry(index + 1, assistant(`message-${index + 1}`)),
		);
		chat.replaceGeneration('chat-1', 'generation-1', initial, {
			lastSeq: ACTIVE_TRANSCRIPT_RETENTION_LIMIT,
			pageOldestSeq: 1,
			hasMore: false,
		});
		chat.visibleMessageCount = INITIAL_VISIBLE_MESSAGES + 50;
		chat.isUserScrolledUp = false;

		chat.applyMessages(
			'chat-1',
			'generation-1',
			Array.from({ length: 50 }, (_, index) =>
				entry(
					ACTIVE_TRANSCRIPT_RETENTION_LIMIT + index + 1,
					assistant(`message-${ACTIVE_TRANSCRIPT_RETENTION_LIMIT + index + 1}`),
				),
			),
		);

		expect(chat.chatMessages).toHaveLength(ACTIVE_TRANSCRIPT_RETENTION_LIMIT + 50);
		expect(chat.visibleMessageCount).toBe(INITIAL_VISIBLE_MESSAGES + 50);
		expect(chat.compactToRecentMessages()).toBe(true);
		expect(chat.chatMessages).toHaveLength(ACTIVE_TRANSCRIPT_RETENTION_LIMIT);
		expect(contentOf(chat.chatMessages[0])).toBe('message-51');
		expect(chat.oldestSeq).toBe(51);
		expect(chat.hasEarlierMessages).toBe(true);
		expect(chat.visibleMessageCount).toBe(INITIAL_VISIBLE_MESSAGES);
	});

	it('deduplicates overlapping earlier pages before extending the loaded window', async () => {
		const chat = new ActiveTranscriptState();
		chat.replaceGeneration(
			'chat-1',
			'generation-1',
			Array.from({ length: 50 }, (_, index) =>
				entry(index + 51, assistant(`message-${index + 51}`)),
			),
			{ lastSeq: 100, pageOldestSeq: 51, hasMore: true },
		);
		vi.mocked(getChatMessages).mockResolvedValueOnce({
			chatId: 'chat-1',
			limit: 50,
			...page({
				messages: [
					entry(50, assistant('message-50')),
					entry(50, assistant('duplicate-50')),
					entry(51, assistant('overlap-51')),
				],
				lastSeq: 100,
				pageOldestSeq: 50,
				hasMore: false,
			}),
		});

		await expect(chat.loadEarlierPage('chat-1')).resolves.toBe('loaded');
		expect(chat.entries.map((message) => message.seq)).toEqual(
			Array.from({ length: 51 }, (_, index) => index + 50),
		);
		expect(chat.visibleMessageCount).toBe(INITIAL_VISIBLE_MESSAGES + 1);
	});

	it('fails an earlier page that claims more history without advancing', async () => {
		const chat = new ActiveTranscriptState();
		chat.replaceGeneration('chat-1', 'generation-1', [entry(51, assistant('message-51'))], {
			lastSeq: 100,
			pageOldestSeq: 51,
			hasMore: true,
		});
		vi.mocked(getChatMessages).mockResolvedValueOnce({
			chatId: 'chat-1',
			limit: 50,
			...page({
				messages: [entry(51, assistant('duplicate-51'))],
				lastSeq: 100,
				pageOldestSeq: 51,
				hasMore: true,
			}),
		});
		vi.spyOn(console, 'error').mockImplementation(() => {});

		await expect(chat.loadEarlierPage('chat-1')).resolves.toBe('failed');
		expect(chat.pageStates.earlier).toMatchObject({
			status: 'error',
			error: 'Earlier transcript page did not advance the loaded window',
		});
		expect(chat.chatMessages).toHaveLength(1);
	});

	it('fails an empty earlier page that still claims more history', async () => {
		const chat = new ActiveTranscriptState();
		chat.replaceGeneration('chat-1', 'generation-1', [entry(51, assistant('message-51'))], {
			lastSeq: 100,
			pageOldestSeq: 51,
			hasMore: true,
		});
		vi.mocked(getChatMessages).mockResolvedValueOnce({
			chatId: 'chat-1',
			limit: 50,
			...page({ messages: [], lastSeq: 100, pageOldestSeq: 0, hasMore: true }),
		});
		vi.spyOn(console, 'error').mockImplementation(() => {});

		await expect(chat.loadEarlierPage('chat-1')).resolves.toBe('failed');
		expect(chat.pageStates.earlier).toMatchObject({
			status: 'error',
			error: 'Earlier transcript page did not advance the loaded window',
		});
		expect(chat.hasEarlierMessages).toBe(true);
	});

	it('invalidates an earlier page when gap recovery replaces the loaded window', async () => {
		const chat = new ActiveTranscriptState();
		chat.replaceGeneration(
			'chat-1',
			'generation-1',
			Array.from({ length: 50 }, (_, index) =>
				entry(index + 51, assistant(`message-${index + 51}`)),
			),
			{ lastSeq: 100, pageOldestSeq: 51, hasMore: true },
		);
		let resolveEarlier!: (value: Awaited<ReturnType<typeof getChatMessages>>) => void;
		vi.mocked(getChatMessages).mockReturnValueOnce(
			new Promise((resolve) => {
				resolveEarlier = resolve;
			}),
		);
		const earlierLoad = chat.loadEarlierPage('chat-1');

		chat.entries = Array.from({ length: 50 }, (_, index) =>
			entry(index + 1, assistant(`stale-${index + 1}`)),
		);
		chat.oldestSeq = 1;
		chat.lastSeq = 50;
		expect(chat.applyMessages('chat-1', 'generation-1', [entry(101, assistant('live'))])).toBe(
			'applied',
		);
		resolveEarlier({
			chatId: 'chat-1',
			limit: 50,
			...page({
				messages: Array.from({ length: 50 }, (_, index) =>
					entry(index + 1, assistant(`earlier-${index + 1}`)),
				),
				lastSeq: 101,
				pageOldestSeq: 1,
				hasMore: false,
			}),
		});

		await expect(earlierLoad).resolves.toBe('invalidated');
		expect(chat.entries.map((message) => message.seq)).toEqual(
			Array.from({ length: 51 }, (_, index) => index + 51),
		);
	});

	it('signals generation changes without replacing the current generation', () => {
		const chat = new ActiveTranscriptState();
		chat.applyMessages('chat-1', 'generation-1', [entry(1, user('old'))]);

		const result = chat.applyMessages('chat-1', 'generation-2', [entry(1, assistant('fresh'))]);

		expect(result).toBe('generation-changed');
		expect(chat.chatMessages.map(contentOf)).toEqual(['old']);
		expect(chat.getCursor()).toEqual({ generationId: 'generation-1', lastSeq: 1 });
	});

	it('renders local messages as transient display-only rows', () => {
		const chat = new ActiveTranscriptState();
		chat.applyMessages('chat-1', 'generation-1', [entry(1, user('server'))]);

		chat.appendLocalNotice('progress', 'local status');
		chat.appendLocalNotice('error', 'local error');

		expect(chat.chatMessages.map(contentOf)).toEqual(['server']);
		expect(chat.visibleRows.map(rowContentOf)).toEqual(['server', 'local status', 'local error']);
		expect(chat.visibleRows.at(-2)).toMatchObject({ kind: 'local-notice', noticeType: 'progress' });
		expect(chat.visibleRows.at(-1)).toMatchObject({ kind: 'local-notice', noticeType: 'error' });
	});

	it('clears transient local messages when new server messages apply', () => {
		const chat = new ActiveTranscriptState();
		chat.applyMessages('chat-1', 'generation-1', [entry(1, user('server'))]);
		chat.appendLocalNotice('progress', 'local status');
		chat.appendLocalNotice('error', 'local error');

		chat.applyMessages('chat-1', 'generation-1', [entry(2, assistant('next'))]);

		expect(chat.visibleRows.map(rowContentOf)).toEqual(['server', 'next']);
	});

	it('clears transient local messages when a pending user input is submitted', () => {
		const chat = new ActiveTranscriptState();
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
		const chat = new ActiveTranscriptState();
		chat.applyMessages('chat-1', 'generation-1', [entry(1, user('server'))]);
		chat.appendLocalNotice('error', 'local error');

		chat.applyMessages('chat-1', 'generation-1', [entry(1, user('duplicate'))]);

		expect(chat.visibleRows.map(rowContentOf)).toEqual(['server', 'local error']);
	});

	it('detects same-generation gaps without advancing the cursor', () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const chat = new ActiveTranscriptState();
		chat.applyMessages('chat-1', 'generation-1', [entry(1, user('server'))]);

		const result = chat.applyMessages('chat-1', 'generation-1', [entry(3, assistant('later'))]);

		expect(result).toBe('gap-detected');
		expect(chat.chatMessages.map(contentOf)).toEqual(['server']);
		expect(chat.getCursor()).toEqual({ generationId: 'generation-1', lastSeq: 1 });
		expect(warn).toHaveBeenCalledWith(expect.stringContaining('expected=2 received=3'));
		warn.mockRestore();
	});

	it('keeps the current transcript visible while a changed generation reloads', () => {
		const chat = new ActiveTranscriptState();
		chat.applyMessages('chat-1', 'generation-1', [entry(1, user('old'))]);
		chat.appendLocalNotice('error', 'local error');

		const result = chat.applyMessages('chat-1', 'generation-2', [entry(1, assistant('fresh'))]);

		expect(result).toBe('generation-changed');
		expect(chat.visibleRows.map(rowContentOf)).toEqual(['old', 'local error']);
		expect(chat.getCursor()).toEqual({ generationId: 'generation-1', lastSeq: 1 });
	});

	it('renders one user row for repeated durable messages with the same request identity', () => {
		const chat = new ActiveTranscriptState();

		chat.applyMessages('chat-1', 'generation-1', [
			entry(1, user('once', { clientRequestId: 'req-1' })),
			entry(2, user('once', { clientRequestId: 'req-1' })),
		]);

		expect(chat.displayMessages.map(contentOf)).toEqual(['once']);
		expect(chat.getCursor()).toEqual({ generationId: 'generation-1', lastSeq: 2 });
	});

	it('exposes canonical durable and pending display row identities', () => {
		const chat = new ActiveTranscriptState();
		chat.replaceGeneration('chat-1', 'generation-1', [entry(1, user('durable'))], {
			lastSeq: 1,
			pageOldestSeq: 1,
			hasMore: false,
		});
		chat.upsertPendingUserInput({
			chatId: 'chat-1',
			clientRequestId: 'request-1',
			content: 'pending',
			createdAt: '2026-06-01T00:00:01.000Z',
			deliveryStatus: 'failed',
		});

		expect(chat.displayRows).toMatchObject([
			{ kind: 'message', id: 'generation-1:1', seq: 1 },
			{ kind: 'message', id: 'pending:request-1' },
		]);
	});

	it('buffers live same-generation messages while a snapshot is loading', () => {
		const chat = new ActiveTranscriptState();
		const epoch = chat.beginSnapshotLoad();

		chat.applyMessages('chat-1', 'generation-1', [entry(2, assistant('live'))]);
		const result = chat.setFromPage(
			'chat-1',
			page({
				generationId: 'generation-1',
				messages: [entry(1, user('history'))],
				lastSeq: 1,
			}),
			epoch,
		);

		expect(result).toBe('applied');
		expect(chat.chatMessages.map(contentOf)).toEqual(['history', 'live']);
		expect(chat.getCursor()).toEqual({ generationId: 'generation-1', lastSeq: 2 });
	});

	it('preserves notices created after buffered live messages across successful snapshots', () => {
		const chat = new ActiveTranscriptState();
		chat.replaceGeneration('chat-1', 'generation-1', [entry(1, assistant('existing'))], {
			lastSeq: 1,
			pageOldestSeq: 1,
			hasMore: false,
		});
		chat.appendLocalNotice('warning', 'stale notice');
		const epoch = chat.beginSnapshotLoad();

		chat.applyMessages('chat-1', 'generation-1', [entry(2, assistant('live'))]);
		chat.appendLocalNotice('error', 'newer notice');
		const result = chat.setFromPage(
			'chat-1',
			page({ messages: [entry(1, assistant('existing'))], lastSeq: 1 }),
			epoch,
		);

		expect(result).toBe('applied');
		expect(chat.chatMessages.map(contentOf)).toEqual(['existing', 'live']);
		expect(chat.visibleRows.map(rowContentOf)).toEqual(['existing', 'live', 'newer notice']);
	});

	it('applies buffered live messages when a snapshot load fails', async () => {
		const chat = new ActiveTranscriptState();
		chat.replaceGeneration('chat-1', 'generation-1', [entry(1, assistant('existing'))], {
			lastSeq: 1,
			pageOldestSeq: 1,
			hasMore: false,
		});
		chat.appendLocalNotice('warning', 'stale notice');
		let rejectSnapshot!: (reason: Error) => void;
		vi.mocked(getChatMessages).mockReturnValueOnce(
			new Promise((_resolve, reject) => {
				rejectSnapshot = reject;
			}),
		);

		const snapshotLoad = chat.loadMessages('chat-1');
		const revisionBeforeLiveMessage = chat.feedMutationClock.dataRevision;
		expect(chat.applyMessages('chat-1', 'generation-1', [entry(2, assistant('live'))])).toBe(
			'applied',
		);
		chat.appendLocalNotice('error', 'newer notice');
		rejectSnapshot(new Error('snapshot unavailable'));

		await expect(snapshotLoad).rejects.toThrow('snapshot unavailable');
		expect(chat.chatMessages.map(contentOf)).toEqual(['existing', 'live']);
		expect(chat.visibleRows.map(rowContentOf)).toEqual(['existing', 'live', 'newer notice']);
		expect(chat.getCursor()).toEqual({ generationId: 'generation-1', lastSeq: 2 });
		expect(chat.feedMutationClock.lastRevisionByKind['live-append']).toBeGreaterThan(
			revisionBeforeLiveMessage,
		);
		expect(chat.feedMutationClock.lastResponseRevisionByMessageType['assistant-message']).toBe(
			chat.feedMutationClock.lastRevisionByKind['live-append'],
		);
		expect(chat.loadStatus).toBe('error');
		expect(chat.loadError).toBe('snapshot unavailable');
	});

	it('preserves buffered live messages across overlapping snapshot loads', async () => {
		const chat = new ActiveTranscriptState();
		chat.replaceGeneration('chat-1', 'generation-1', [entry(1, assistant('existing'))], {
			lastSeq: 1,
			pageOldestSeq: 1,
			hasMore: false,
		});
		let resolveFirstSnapshot!: (value: Awaited<ReturnType<typeof getChatMessages>>) => void;
		let resolveSecondSnapshot!: (value: Awaited<ReturnType<typeof getChatMessages>>) => void;
		vi.mocked(getChatMessages)
			.mockReturnValueOnce(
				new Promise((resolve) => {
					resolveFirstSnapshot = resolve;
				}),
			)
			.mockReturnValueOnce(
				new Promise((resolve) => {
					resolveSecondSnapshot = resolve;
				}),
			);

		const firstLoad = chat.loadMessages('chat-1');
		chat.applyMessages('chat-1', 'generation-1', [entry(2, assistant('live'))]);
		const secondLoad = chat.loadMessages('chat-1');
		resolveSecondSnapshot({
			chatId: 'chat-1',
			limit: 50,
			...page({ messages: [entry(1, assistant('existing'))], lastSeq: 1 }),
		});

		await expect(secondLoad).resolves.toEqual([
			expect.objectContaining({ content: 'existing' }),
			expect.objectContaining({ content: 'live' }),
		]);
		resolveFirstSnapshot({
			chatId: 'chat-1',
			limit: 50,
			...page({ messages: [entry(1, assistant('existing'))], lastSeq: 1 }),
		});
		await expect(firstLoad).resolves.toEqual([
			expect.objectContaining({ content: 'existing' }),
			expect.objectContaining({ content: 'live' }),
		]);
		expect(chat.getCursor()).toEqual({ generationId: 'generation-1', lastSeq: 2 });
	});

	it('preserves notices created after a superseding snapshot starts', async () => {
		const chat = new ActiveTranscriptState();
		chat.replaceGeneration('chat-1', 'generation-1', [entry(1, assistant('existing'))], {
			lastSeq: 1,
			pageOldestSeq: 1,
			hasMore: false,
		});
		let resolveFirstSnapshot!: (value: Awaited<ReturnType<typeof getChatMessages>>) => void;
		let resolveSecondSnapshot!: (value: Awaited<ReturnType<typeof getChatMessages>>) => void;
		vi.mocked(getChatMessages)
			.mockReturnValueOnce(
				new Promise((resolve) => {
					resolveFirstSnapshot = resolve;
				}),
			)
			.mockReturnValueOnce(
				new Promise((resolve) => {
					resolveSecondSnapshot = resolve;
				}),
			);

		const firstLoad = chat.loadMessages('chat-1');
		const secondLoad = chat.loadMessages('chat-1');
		resolveFirstSnapshot({
			chatId: 'chat-1',
			limit: 50,
			...page({ messages: [entry(1, assistant('existing'))], lastSeq: 1 }),
		});
		await firstLoad;
		chat.appendLocalNotice('error', 'newer notice');
		resolveSecondSnapshot({
			chatId: 'chat-1',
			limit: 50,
			...page({ messages: [entry(1, assistant('existing'))], lastSeq: 1 }),
		});

		await secondLoad;
		expect(chat.visibleRows.map(rowContentOf)).toEqual(['existing', 'newer notice']);
	});

	it('clears loading state when switching away from an active snapshot load', async () => {
		const chat = new ActiveTranscriptState();
		chat.replaceGeneration('chat-1', 'generation-1', [entry(1, assistant('existing'))], {
			lastSeq: 1,
			pageOldestSeq: 1,
			hasMore: false,
		});
		let resolveSnapshot!: (value: Awaited<ReturnType<typeof getChatMessages>>) => void;
		vi.mocked(getChatMessages).mockReturnValueOnce(
			new Promise((resolve) => {
				resolveSnapshot = resolve;
			}),
		);

		const snapshotLoad = chat.loadMessages('chat-1');
		expect(chat.isLoadingMessages).toBe(true);
		chat.activateChat('chat-draft');
		expect(chat.isLoadingMessages).toBe(false);
		resolveSnapshot({
			chatId: 'chat-1',
			limit: 50,
			...page({ messages: [entry(1, assistant('existing'))], lastSeq: 1 }),
		});

		await snapshotLoad;
		expect(chat.activeChatId).toBe('chat-draft');
		expect(chat.loadStatus).toBe('idle');
		expect(chat.isLoadingMessages).toBe(false);
	});

	it('does not let a stale snapshot failure overwrite the active chat load state', async () => {
		const chat = new ActiveTranscriptState();
		chat.replaceGeneration('chat-1', 'generation-1', [entry(1, assistant('one'))], {
			lastSeq: 1,
			pageOldestSeq: 1,
			hasMore: false,
		});
		let rejectFirstSnapshot!: (reason: Error) => void;
		vi.mocked(getChatMessages)
			.mockReturnValueOnce(
				new Promise((_resolve, reject) => {
					rejectFirstSnapshot = reject;
				}),
			)
			.mockResolvedValueOnce({
				chatId: 'chat-2',
				limit: 50,
				...page({
					generationId: 'generation-2',
					messages: [entry(1, assistant('two'))],
				}),
			});

		const firstLoad = chat.loadMessages('chat-1');
		chat.activateChat('chat-2');
		await chat.loadMessages('chat-2');
		rejectFirstSnapshot(new Error('old chat failed'));

		await expect(firstLoad).rejects.toThrow('old chat failed');
		expect(chat.activeChatId).toBe('chat-2');
		expect(chat.chatMessages.map(contentOf)).toEqual(['two']);
		expect(chat.loadStatus).toBe('loaded');
		expect(chat.loadError).toBeNull();
	});

	it('surfaces buffered same-generation gaps during snapshot load', () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const chat = new ActiveTranscriptState();
		const epoch = chat.beginSnapshotLoad();

		chat.applyMessages('chat-1', 'generation-1', [entry(5, assistant('later'))]);
		const result = chat.setFromPage(
			'chat-1',
			page({
				generationId: 'generation-1',
				messages: [entry(1, user('one')), entry(2, assistant('two')), entry(3, assistant('three'))],
				lastSeq: 3,
			}),
			epoch,
		);

		expect(result).toBe('gap-detected');
		expect(chat.chatMessages.map(contentOf)).toEqual(['one', 'two', 'three']);
		expect(chat.getCursor()).toEqual({ generationId: 'generation-1', lastSeq: 3 });
		warn.mockRestore();
	});

	it('does not install a stale snapshot when buffered messages indicate a new generation', () => {
		const chat = new ActiveTranscriptState();
		chat.replaceGeneration('chat-1', 'current-generation', [entry(1, assistant('current'))], {
			lastSeq: 1,
			pageOldestSeq: 1,
			hasMore: false,
		});
		const epoch = chat.beginSnapshotLoad();

		chat.applyMessages('chat-1', 'new-generation', [entry(1, assistant('new live'))]);
		const result = chat.setFromPage(
			'chat-1',
			page({
				generationId: 'old-generation',
				messages: [entry(1, user('old page'))],
				lastSeq: 1,
			}),
			epoch,
		);

		expect(result).toBe('generation-changed');
		expect(chat.chatMessages.map(contentOf)).toEqual(['current']);
		expect(chat.getCursor()).toEqual({ generationId: 'current-generation', lastSeq: 1 });
	});

	it.each(['initial', 'latest'] as const)(
		'preserves snapshot reload ownership when %s navigation races a generation change',
		async (target) => {
			const chat = new ActiveTranscriptState();
			chat.replaceGeneration('chat-1', 'generation-1', [entry(1, assistant('current'))], {
				lastSeq: 1,
				pageOldestSeq: 1,
				hasMore: false,
			});
			let resolveOldSnapshot!: (value: Awaited<ReturnType<typeof getChatMessages>>) => void;
			let resolveNewSnapshot!: (value: Awaited<ReturnType<typeof getChatMessages>>) => void;
			vi.mocked(getChatMessages)
				.mockReturnValueOnce(
					new Promise((resolve) => {
						resolveOldSnapshot = resolve;
					}),
				)
				.mockReturnValueOnce(
					new Promise((resolve) => {
						resolveNewSnapshot = resolve;
					}),
				);

			const snapshotLoad = chat.loadMessages('chat-1');
			expect(getChatMessages).toHaveBeenCalledOnce();
			expect(chat.applyMessages('chat-1', 'generation-2', [entry(1, assistant('new live'))])).toBe(
				'applied',
			);

			await expect(chat.navigateToWindow('chat-1', target)).resolves.toBe('invalidated');
			expect(getChatMessages).toHaveBeenCalledOnce();

			resolveOldSnapshot({
				chatId: 'chat-1',
				limit: 50,
				...page({
					generationId: 'generation-1',
					messages: [entry(1, assistant('old snapshot'))],
					lastSeq: 1,
				}),
			});
			await vi.waitFor(() => expect(getChatMessages).toHaveBeenCalledTimes(2));
			resolveNewSnapshot({
				chatId: 'chat-1',
				limit: 50,
				...page({
					generationId: 'generation-2',
					messages: [entry(1, assistant('new snapshot'))],
					lastSeq: 1,
				}),
			});

			await expect(snapshotLoad).resolves.toEqual([
				expect.objectContaining({ content: 'new snapshot' }),
			]);
			expect(chat.chatMessages.map(contentOf)).toEqual(['new snapshot']);
			expect(chat.getCursor()).toEqual({ generationId: 'generation-2', lastSeq: 1 });
		},
	);

	it('installs pending inputs from HTTP snapshots and hides them after durable echo', () => {
		const chat = new ActiveTranscriptState();
		const epoch = chat.beginSnapshotLoad();

		chat.setFromPage(
			'chat-1',
			page({
				messages: [],
				lastSeq: 0,
				pendingUserInputs: [
					{
						chatId: 'chat-1',
						clientRequestId: 'req-1',
						content: 'pending',
						createdAt: TS,
						deliveryStatus: 'accepted',
					},
				],
			}),
			epoch,
		);
		expect(chat.visiblePendingInputs).toHaveLength(1);
		expect(chat.displayMessages.map(contentOf)).toEqual(['pending']);

		chat.applyMessages('chat-1', 'generation-1', [
			entry(1, user('pending', { clientRequestId: 'req-1', deliveryStatus: 'accepted' })),
		]);

		expect(chat.visiblePendingInputs).toHaveLength(0);
		expect(chat.displayMessages.map(contentOf)).toEqual(['pending']);
	});

	it('renders byte-free attachment placeholders for restored pending inputs', () => {
		const chat = new ActiveTranscriptState();
		chat.setPendingUserInputs([
			{
				chatId: 'chat-1',
				clientRequestId: 'req-attachment',
				content: '',
				createdAt: TS,
				deliveryStatus: 'failed',
				attachments: [{ name: 'context.pdf', mimeType: 'application/pdf' }],
			},
		]);

		expect(chat.displayMessages).toHaveLength(1);
		expect(chat.displayMessages[0]).toMatchObject({
			type: 'user-message',
			content: '',
			images: [
				{
					name: 'context.pdf',
					mimeType: 'application/octet-stream',
					data: '',
				},
			],
			metadata: { deliveryStatus: 'failed' },
		});
	});

	it('projects a failed pending status onto its durable user row without duplication', () => {
		const chat = new ActiveTranscriptState();
		chat.applyMessages('chat-1', 'generation-1', [
			entry(
				1,
				user('pending', {
					clientRequestId: 'req-1',
					deliveryStatus: 'accepted',
				}),
			),
		]);
		chat.setPendingUserInputs([
			{
				chatId: 'chat-1',
				clientRequestId: 'req-1',
				content: 'pending',
				createdAt: TS,
				deliveryStatus: 'failed',
			},
		]);

		expect(chat.visiblePendingInputs).toHaveLength(0);
		expect(chat.displayMessages).toHaveLength(1);
		expect(chat.displayMessages[0]).toMatchObject({
			type: 'user-message',
			metadata: { clientRequestId: 'req-1', deliveryStatus: 'failed' },
		});
		expect(chat.entries[0].message).toMatchObject({
			metadata: { clientRequestId: 'req-1', deliveryStatus: 'accepted' },
		});
		expect(chat.getCursor()).toEqual({ generationId: 'generation-1', lastSeq: 1 });
	});

	it('projects an unconfirmed pending status onto its durable user row without duplication', () => {
		const chat = new ActiveTranscriptState();
		chat.applyMessages('chat-1', 'generation-1', [
			entry(
				1,
				user('pending', {
					clientRequestId: 'req-1',
					deliveryStatus: 'accepted',
				}),
			),
		]);
		chat.setPendingUserInputs([
			{
				chatId: 'chat-1',
				clientRequestId: 'req-1',
				content: 'pending',
				createdAt: TS,
				deliveryStatus: 'unconfirmed',
			},
		]);

		expect(chat.visiblePendingInputs).toHaveLength(0);
		expect(chat.displayMessages).toHaveLength(1);
		expect(chat.displayMessages[0]).toMatchObject({
			type: 'user-message',
			metadata: { clientRequestId: 'req-1', deliveryStatus: 'unconfirmed' },
		});
	});

	it('clears pending overlays when a generation is replaced without snapshot pending inputs', () => {
		const chat = new ActiveTranscriptState();
		chat.setPendingUserInputs([
			{
				chatId: 'chat-1',
				clientRequestId: 'req-1',
				content: 'pending',
				createdAt: TS,
				deliveryStatus: 'accepted',
			},
		]);

		chat.replaceGeneration(
			'chat-1',
			'generation-2',
			[entry(1, assistant('native')), entry(2, new ErrorMessage(TS, 'The process died.'))],
			{ lastSeq: 2, pageOldestSeq: 1, hasMore: false },
		);

		expect(chat.pendingUserInputs).toEqual([]);
		expect(chat.chatMessages.map(contentOf)).toEqual(['native', 'The process died.']);
		expect(chat.chatMessages[1]).toBeInstanceOf(ErrorMessage);
	});

	it('persists and activates generation-scoped transcript windows', () => {
		const chat = new ActiveTranscriptState();
		chat.applyMessages('chat-1', 'generation-1', [
			entry(1, user('first')),
			entry(2, assistant('second')),
		]);
		chat.transcriptCache.flush();

		const restored = new ActiveTranscriptState();
		const result = restored.activateChat('chat-1');

		expect(result).toEqual({ count: 2, stale: false });
		expect(restored.getCursor()).toEqual({ generationId: 'generation-1', lastSeq: 2 });
		expect(restored.chatMessages.map(contentOf)).toEqual(['first', 'second']);
	});

	it('reveals a restored transcript window in bounded switch batches', () => {
		const transcriptCache = new ChatTranscriptCache({ limit: 100 });
		const messages = Array.from({ length: 100 }, (_, index) =>
			entry(index + 1, assistant(`message-${index + 1}`)),
		);
		transcriptCache.replaceFromPage('chat-1', {
			generationId: 'generation-1',
			messages,
			lastSeq: 100,
			pageOldestSeq: 1,
			hasMore: false,
		});
		const chat = new ActiveTranscriptState(transcriptCache);

		chat.activateChat('chat-1');

		expect(chat.visibleRows).toHaveLength(20);
		expect(chat.hasInitialMessagesToReveal).toBe(true);
		chat.revealInitialMessages();
		expect(chat.visibleRows).toHaveLength(40);
		for (let index = 0; index < 3; index += 1) chat.revealInitialMessages();
		expect(chat.visibleRows).toHaveLength(100);
		expect(chat.hasInitialMessagesToReveal).toBe(false);
		expect(chat.visibleMessageCount).toBe(INITIAL_VISIBLE_MESSAGES);
	});

	it('permanently completes a partial restored transcript after revealing its snapshot', () => {
		const transcriptCache = new ChatTranscriptCache({ limit: 100 });
		const messages = Array.from({ length: 30 }, (_, index) =>
			entry(index + 1, assistant(`message-${index + 1}`)),
		);
		transcriptCache.replaceFromPage('chat-1', {
			generationId: 'generation-1',
			messages,
			lastSeq: 30,
			pageOldestSeq: 1,
			hasMore: false,
		});
		const chat = new ActiveTranscriptState(transcriptCache);

		chat.activateChat('chat-1');
		chat.revealInitialMessages();

		expect(chat.visibleRows).toHaveLength(30);
		expect(chat.visibleMessageCount).toBe(INITIAL_VISIBLE_MESSAGES);
		expect(chat.hasInitialMessagesToReveal).toBe(false);

		chat.applyMessages(
			'chat-1',
			'generation-1',
			Array.from({ length: 30 }, (_, index) =>
				entry(index + 31, assistant(`message-${index + 31}`)),
			),
		);

		expect(chat.visibleRows).toHaveLength(60);
		expect(chat.hasInitialMessagesToReveal).toBe(false);
	});

	it('keeps every explicitly revealed row visible as live messages append', () => {
		const chat = new ActiveTranscriptState();
		const messages = Array.from({ length: 175 }, (_, index) =>
			entry(index + 1, assistant(`message-${index + 1}`)),
		);
		chat.replaceGeneration('chat-1', 'generation-1', messages, {
			lastSeq: 175,
			pageOldestSeq: 1,
			hasMore: false,
		});

		expect(chat.visibleRows).toHaveLength(INITIAL_VISIBLE_MESSAGES);
		chat.revealAllLoadedMessages();

		expect(chat.visibleRows).toHaveLength(175);
		expect(chat.visibleRows[0]).toMatchObject({ id: 'generation-1:1', seq: 1 });
		expect(chat.hasInitialMessagesToReveal).toBe(false);

		chat.applyMessages('chat-1', 'generation-1', [entry(176, assistant('message-176'))]);

		expect(chat.visibleRows).toHaveLength(176);
		expect(chat.visibleRows[0]).toMatchObject({ id: 'generation-1:1', seq: 1 });
	});

	it.each([0, 20])(
		'permanently completes an initially loaded %i-message snapshot before later growth',
		(messageCount) => {
			const chat = new ActiveTranscriptState();
			chat.activateChat('chat-1');
			const epoch = chat.beginSnapshotLoad();
			chat.setFromPage(
				'chat-1',
				{
					generationId: 'generation-1',
					messages: Array.from({ length: messageCount }, (_, index) =>
						entry(index + 1, assistant(`message-${index + 1}`)),
					),
					lastSeq: messageCount,
					pageOldestSeq: messageCount === 0 ? 0 : 1,
					hasMore: false,
					pendingUserInputs: [],
				},
				epoch,
			);

			expect(chat.visibleMessageCount).toBe(INITIAL_VISIBLE_MESSAGES);
			expect(chat.hasInitialMessagesToReveal).toBe(false);

			chat.applyMessages(
				'chat-1',
				'generation-1',
				Array.from({ length: 40 - messageCount }, (_, index) =>
					entry(messageCount + index + 1, assistant(`new-${index + 1}`)),
				),
			);

			expect(chat.visibleRows).toHaveLength(40);
			expect(chat.hasInitialMessagesToReveal).toBe(false);
		},
	);

	it('bounds the first render when a switched chat is not cached yet', () => {
		const chat = new ActiveTranscriptState();
		const messages = Array.from({ length: 100 }, (_, index) =>
			entry(index + 1, assistant(`message-${index + 1}`)),
		);

		expect(chat.activateChat('chat-1')).toBeNull();
		const epoch = chat.beginSnapshotLoad();
		chat.setFromPage(
			'chat-1',
			{
				generationId: 'generation-1',
				messages,
				lastSeq: 100,
				pageOldestSeq: 1,
				hasMore: false,
				pendingUserInputs: [],
			},
			epoch,
		);

		expect(chat.visibleRows).toHaveLength(20);
		expect(chat.hasInitialMessagesToReveal).toBe(true);
	});

	it('loads only the first page for initial-prompt navigation', async () => {
		const chat = new ActiveTranscriptState();
		chat.replaceGeneration(
			'chat-1',
			'generation-1',
			Array.from({ length: 50 }, (_, index) =>
				entry(index + 5_995, assistant(`message-${index + 5_995}`)),
			),
			{ lastSeq: 6_044, pageOldestSeq: 5_995, hasMore: true },
		);
		vi.mocked(getChatMessages).mockResolvedValueOnce({
			chatId: 'chat-1',
			limit: 50,
			...page({
				messages: Array.from({ length: 50 }, (_, index) =>
					entry(index + 1, assistant(`message-${index + 1}`)),
				),
				lastSeq: 6_044,
				pageOldestSeq: 1,
				hasMore: false,
			}),
		});

		await expect(chat.navigateToWindow('chat-1', 'initial')).resolves.toBe('loaded');

		expect(getChatMessages).toHaveBeenCalledOnce();
		expect(getChatMessages).toHaveBeenCalledWith({
			chatId: 'chat-1',
			limit: 50,
			beforeSeq: 51,
		});
		expect(chat.visibleRows).toHaveLength(50);
		expect(chat.visibleRows[0]).toMatchObject({ kind: 'message', seq: 1 });
		expect(chat.visibleRows.at(-1)).toMatchObject({ kind: 'message', seq: 50 });
		expect(chat.hasLaterMessages).toBe(true);
		expect(chat.getCursor()).toEqual({ generationId: 'generation-1', lastSeq: 6_044 });
		expect(chat.transcriptCache.get('chat-1')?.messages[0]).toMatchObject({ seq: 5_995 });
	});

	it('pages forward from the initial window until it rejoins the live transcript', async () => {
		const chat = new ActiveTranscriptState();
		chat.replaceGeneration(
			'chat-1',
			'generation-1',
			Array.from({ length: 50 }, (_, index) =>
				entry(index + 71, assistant(`message-${index + 71}`)),
			),
			{ lastSeq: 120, pageOldestSeq: 71, hasMore: true },
		);
		vi.mocked(getChatMessages)
			.mockResolvedValueOnce({
				chatId: 'chat-1',
				limit: 50,
				...page({
					messages: Array.from({ length: 50 }, (_, index) =>
						entry(index + 1, assistant(`message-${index + 1}`)),
					),
					lastSeq: 120,
					pageOldestSeq: 1,
				}),
			})
			.mockResolvedValueOnce({
				chatId: 'chat-1',
				limit: 50,
				...page({
					messages: Array.from({ length: 50 }, (_, index) =>
						entry(index + 51, assistant(`message-${index + 51}`)),
					),
					lastSeq: 120,
					pageOldestSeq: 51,
					hasMore: true,
				}),
			})
			.mockResolvedValueOnce({
				chatId: 'chat-1',
				limit: 50,
				...page({
					messages: Array.from({ length: 50 }, (_, index) =>
						entry(index + 71, assistant(`message-${index + 71}`)),
					),
					lastSeq: 120,
					pageOldestSeq: 71,
					hasMore: true,
				}),
			});

		await expect(chat.navigateToWindow('chat-1', 'initial')).resolves.toBe('loaded');
		await expect(chat.loadLaterPage('chat-1')).resolves.toBe('loaded');

		expect(getChatMessages).toHaveBeenNthCalledWith(2, {
			chatId: 'chat-1',
			limit: 50,
			beforeSeq: 101,
		});
		expect(chat.entries).toHaveLength(100);
		expect(chat.entries.at(-1)).toMatchObject({ seq: 100 });
		expect(chat.hasLaterMessages).toBe(true);

		await expect(chat.loadLaterPage('chat-1')).resolves.toBe('loaded');

		expect(getChatMessages).toHaveBeenNthCalledWith(3, {
			chatId: 'chat-1',
			limit: 50,
			beforeSeq: 121,
		});
		expect(chat.entries).toHaveLength(120);
		expect(chat.visibleRows).toHaveLength(120);
		expect(chat.hasLaterMessages).toBe(false);
		expect(chat.getCursor()).toEqual({ generationId: 'generation-1', lastSeq: 120 });
		expect(chat.transcriptCache.get('chat-1')?.messages[0]).toMatchObject({ seq: 71 });
	});

	it('chases live messages that arrive while paging forward from the initial window', async () => {
		const chat = new ActiveTranscriptState();
		chat.replaceGeneration(
			'chat-1',
			'generation-1',
			Array.from({ length: 50 }, (_, index) =>
				entry(index + 51, assistant(`message-${index + 51}`)),
			),
			{ lastSeq: 100, pageOldestSeq: 51, hasMore: true },
		);
		vi.mocked(getChatMessages)
			.mockResolvedValueOnce({
				chatId: 'chat-1',
				limit: 50,
				...page({
					messages: Array.from({ length: 50 }, (_, index) =>
						entry(index + 1, assistant(`message-${index + 1}`)),
					),
					lastSeq: 100,
					pageOldestSeq: 1,
				}),
			})
			.mockResolvedValueOnce({
				chatId: 'chat-1',
				limit: 50,
				...page({
					messages: Array.from({ length: 50 }, (_, index) =>
						entry(index + 51, assistant(`message-${index + 51}`)),
					),
					lastSeq: 102,
					pageOldestSeq: 51,
					hasMore: true,
				}),
			})
			.mockResolvedValueOnce({
				chatId: 'chat-1',
				limit: 50,
				...page({
					messages: Array.from({ length: 50 }, (_, index) =>
						entry(index + 53, assistant(`message-${index + 53}`)),
					),
					lastSeq: 102,
					pageOldestSeq: 53,
					hasMore: true,
				}),
			});

		await expect(chat.navigateToWindow('chat-1', 'initial')).resolves.toBe('loaded');
		expect(
			chat.applyMessages('chat-1', 'generation-1', [
				entry(101, assistant('message-101')),
				entry(102, assistant('message-102')),
			]),
		).toBe('applied');

		await expect(chat.loadLaterPage('chat-1')).resolves.toBe('loaded');
		expect(chat.entries.at(-1)).toMatchObject({ seq: 100 });
		expect(chat.hasLaterMessages).toBe(true);
		expect(chat.getCursor()).toEqual({ generationId: 'generation-1', lastSeq: 102 });

		await expect(chat.loadLaterPage('chat-1')).resolves.toBe('loaded');
		expect(chat.entries.map((item) => item.seq)).toEqual(
			Array.from({ length: 102 }, (_, index) => index + 1),
		);
		expect(chat.hasLaterMessages).toBe(false);
		expect(chat.getCursor()).toEqual({ generationId: 'generation-1', lastSeq: 102 });
	});

	it('coalesces concurrent forward page requests for the detached window', async () => {
		const chat = new ActiveTranscriptState();
		chat.replaceGeneration(
			'chat-1',
			'generation-1',
			Array.from({ length: 50 }, (_, index) =>
				entry(index + 51, assistant(`message-${index + 51}`)),
			),
			{ lastSeq: 100, pageOldestSeq: 51, hasMore: true },
		);
		let resolveForwardPage!: (value: Awaited<ReturnType<typeof getChatMessages>>) => void;
		vi.mocked(getChatMessages)
			.mockResolvedValueOnce({
				chatId: 'chat-1',
				limit: 50,
				...page({
					messages: Array.from({ length: 50 }, (_, index) =>
						entry(index + 1, assistant(`message-${index + 1}`)),
					),
					lastSeq: 100,
					pageOldestSeq: 1,
				}),
			})
			.mockReturnValueOnce(
				new Promise((resolve) => {
					resolveForwardPage = resolve;
				}),
			);

		await expect(chat.navigateToWindow('chat-1', 'initial')).resolves.toBe('loaded');
		const firstLoad = chat.loadLaterPage('chat-1');
		const secondLoad = chat.loadLaterPage('chat-1');

		expect(getChatMessages).toHaveBeenCalledTimes(2);
		expect(chat.pageStates.later.status).toBe('loading');
		resolveForwardPage({
			chatId: 'chat-1',
			limit: 50,
			...page({
				messages: Array.from({ length: 50 }, (_, index) =>
					entry(index + 51, assistant(`message-${index + 51}`)),
				),
				lastSeq: 100,
				pageOldestSeq: 51,
				hasMore: true,
			}),
		});

		await expect(Promise.all([firstLoad, secondLoad])).resolves.toEqual(['loaded', 'loaded']);
		expect(getChatMessages).toHaveBeenCalledTimes(2);
		expect(chat.entries).toHaveLength(100);
		expect(chat.hasLaterMessages).toBe(false);
		expect(chat.pageStates.later.status).toBe('idle');
	});

	it('keeps a failed later page directional and retryable', async () => {
		const chat = new ActiveTranscriptState();
		chat.replaceGeneration(
			'chat-1',
			'generation-1',
			Array.from({ length: 50 }, (_, index) =>
				entry(index + 51, assistant(`message-${index + 51}`)),
			),
			{ lastSeq: 100, pageOldestSeq: 51, hasMore: true },
		);
		vi.mocked(getChatMessages)
			.mockResolvedValueOnce({
				chatId: 'chat-1',
				limit: 50,
				...page({
					messages: Array.from({ length: 50 }, (_, index) =>
						entry(index + 1, assistant(`message-${index + 1}`)),
					),
					lastSeq: 100,
					pageOldestSeq: 1,
				}),
			})
			.mockRejectedValueOnce(new Error('network unavailable'))
			.mockResolvedValueOnce({
				chatId: 'chat-1',
				limit: 50,
				...page({
					messages: Array.from({ length: 50 }, (_, index) =>
						entry(index + 51, assistant(`message-${index + 51}`)),
					),
					lastSeq: 100,
					pageOldestSeq: 51,
				}),
			});

		await chat.navigateToWindow('chat-1', 'initial');
		await expect(chat.loadLaterPage('chat-1')).resolves.toBe('failed');

		expect(chat.pageStates.later).toEqual({
			status: 'error',
			error: 'network unavailable',
		});
		expect(chat.hasLaterMessages).toBe(true);

		await expect(chat.loadLaterPage('chat-1')).resolves.toBe('loaded');
		expect(chat.pageStates.later.status).toBe('idle');
		expect(chat.hasLaterMessages).toBe(false);
	});

	it('keeps the reconnect cursor behind an unseen initial-window server head', async () => {
		const chat = new ActiveTranscriptState();
		chat.replaceGeneration(
			'chat-1',
			'generation-1',
			Array.from({ length: 50 }, (_, index) =>
				entry(index + 51, assistant(`latest-${index + 51}`)),
			),
			{ lastSeq: 100, pageOldestSeq: 51, hasMore: true },
		);
		let resolveInitial!: (value: Awaited<ReturnType<typeof getChatMessages>>) => void;
		vi.mocked(getChatMessages).mockReturnValueOnce(
			new Promise((resolve) => {
				resolveInitial = resolve;
			}),
		);

		const initial = chat.navigateToWindow('chat-1', 'initial');
		resolveInitial({
			chatId: 'chat-1',
			limit: 50,
			...page({
				messages: Array.from({ length: 50 }, (_, index) =>
					entry(index + 1, assistant(`initial-${index + 1}`)),
				),
				lastSeq: 101,
				pageOldestSeq: 1,
				hasMore: false,
			}),
		});

		await expect(initial).resolves.toBe('loaded');
		expect(chat.hasLaterMessages).toBe(true);
		expect(chat.getCursor()).toEqual({ generationId: 'generation-1', lastSeq: 100 });
		expect(chat.transcriptCache.get('chat-1')?.lastSeq).toBe(100);

		expect(chat.applyMessages('chat-1', 'generation-1', [entry(101, assistant('unseen'))])).toBe(
			'applied',
		);
		expect(chat.getCursor()).toEqual({ generationId: 'generation-1', lastSeq: 101 });
	});

	it('keeps the latest window when Bottom supersedes a pending Initial request', async () => {
		const chat = new ActiveTranscriptState();
		const latestWindow = Array.from({ length: 50 }, (_, index) =>
			entry(index + 51, assistant(`latest-${index + 51}`)),
		);
		chat.replaceGeneration('chat-1', 'generation-1', latestWindow, {
			lastSeq: 100,
			pageOldestSeq: 51,
			hasMore: true,
		});
		let resolveInitial!: (value: Awaited<ReturnType<typeof getChatMessages>>) => void;
		vi.mocked(getChatMessages).mockReturnValueOnce(
			new Promise((resolve) => {
				resolveInitial = resolve;
			}),
		);

		const initial = chat.navigateToWindow('chat-1', 'initial');
		await expect(chat.navigateToWindow('chat-1', 'latest')).resolves.toBe('loaded');
		resolveInitial({
			chatId: 'chat-1',
			limit: 50,
			...page({
				messages: Array.from({ length: 50 }, (_, index) =>
					entry(index + 1, assistant(`initial-${index + 1}`)),
				),
				lastSeq: 100,
				pageOldestSeq: 1,
				hasMore: false,
			}),
		});

		await expect(initial).resolves.toBe('invalidated');
		expect(chat.chatMessages.map(contentOf)).toEqual(
			Array.from({ length: 50 }, (_, index) => `latest-${index + 51}`),
		);
		expect(chat.hasLaterMessages).toBe(false);
	});

	it('discards a pending window navigation after explicit invalidation', async () => {
		const chat = new ActiveTranscriptState();
		const latestWindow = Array.from({ length: 50 }, (_, index) =>
			entry(index + 51, assistant(`latest-${index + 51}`)),
		);
		chat.replaceGeneration('chat-1', 'generation-1', latestWindow, {
			lastSeq: 100,
			pageOldestSeq: 51,
			hasMore: true,
		});
		let resolveInitial!: (value: Awaited<ReturnType<typeof getChatMessages>>) => void;
		vi.mocked(getChatMessages).mockReturnValueOnce(
			new Promise((resolve) => {
				resolveInitial = resolve;
			}),
		);

		const initial = chat.navigateToWindow('chat-1', 'initial');
		chat.invalidatePendingWindowNavigation();
		resolveInitial({
			chatId: 'chat-1',
			limit: 50,
			...page({
				messages: Array.from({ length: 50 }, (_, index) =>
					entry(index + 1, assistant(`initial-${index + 1}`)),
				),
				lastSeq: 100,
				pageOldestSeq: 1,
				hasMore: false,
			}),
		});

		await expect(initial).resolves.toBe('invalidated');
		expect(chat.chatMessages.map(contentOf)).toEqual(
			Array.from({ length: 50 }, (_, index) => `latest-${index + 51}`),
		);
		expect(chat.hasLaterMessages).toBe(false);
	});

	it('keeps the initial window when Initial supersedes a pending Bottom request', async () => {
		const chat = new ActiveTranscriptState();
		chat.replaceGeneration(
			'chat-1',
			'generation-1',
			Array.from({ length: 50 }, (_, index) =>
				entry(index + 51, assistant(`latest-${index + 51}`)),
			),
			{ lastSeq: 100, pageOldestSeq: 51, hasMore: true },
		);
		chat.entries = Array.from({ length: 50 }, (_, index) =>
			entry(index + 1, assistant(`initial-${index + 1}`)),
		);
		chat.oldestSeq = 1;
		chat.hasEarlierMessages = false;
		chat.visibleMessageCount = 50;
		let resolveLatest!: (value: Awaited<ReturnType<typeof getChatMessages>>) => void;
		vi.mocked(getChatMessages).mockReturnValueOnce(
			new Promise((resolve) => {
				resolveLatest = resolve;
			}),
		);

		const latest = chat.navigateToWindow('chat-1', 'latest');
		await expect(chat.navigateToWindow('chat-1', 'initial')).resolves.toBe('loaded');
		expect(chat.isLoadingMessages).toBe(false);
		expect(chat.loadStatus).toBe('loaded');
		resolveLatest({
			chatId: 'chat-1',
			limit: 50,
			...page({
				messages: Array.from({ length: 50 }, (_, index) =>
					entry(index + 51, assistant(`latest-${index + 51}`)),
				),
				lastSeq: 100,
				pageOldestSeq: 51,
				hasMore: true,
			}),
		});

		await expect(latest).resolves.toBe('invalidated');
		expect(chat.chatMessages.map(contentOf)).toEqual(
			Array.from({ length: 50 }, (_, index) => `initial-${index + 1}`),
		);
		expect(chat.hasLaterMessages).toBe(true);
		expect(chat.isLoadingMessages).toBe(false);
		expect(chat.loadStatus).toBe('loaded');
		expect(chat.loadError).toBeNull();
	});

	it('ignores a stale Bottom rejection after Initial restores the existing initial window', async () => {
		const chat = new ActiveTranscriptState();
		chat.replaceGeneration(
			'chat-1',
			'generation-1',
			Array.from({ length: 50 }, (_, index) =>
				entry(index + 51, assistant(`latest-${index + 51}`)),
			),
			{ lastSeq: 100, pageOldestSeq: 51, hasMore: true },
		);
		chat.entries = Array.from({ length: 50 }, (_, index) =>
			entry(index + 1, assistant(`initial-${index + 1}`)),
		);
		chat.oldestSeq = 1;
		chat.hasEarlierMessages = false;
		chat.visibleMessageCount = 50;
		let rejectLatest!: (reason: Error) => void;
		vi.mocked(getChatMessages).mockReturnValueOnce(
			new Promise((_resolve, reject) => {
				rejectLatest = reject;
			}),
		);

		const latest = chat.navigateToWindow('chat-1', 'latest');
		await expect(chat.navigateToWindow('chat-1', 'initial')).resolves.toBe('loaded');
		rejectLatest(new Error('stale latest failure'));

		await expect(latest).resolves.toBe('invalidated');
		expect(chat.hasLaterMessages).toBe(true);
		expect(chat.isLoadingMessages).toBe(false);
		expect(chat.loadStatus).toBe('loaded');
		expect(chat.loadError).toBeNull();
	});

	it('keeps live messages in the latest cache while viewing the initial page', async () => {
		const chat = new ActiveTranscriptState();
		chat.replaceGeneration(
			'chat-1',
			'generation-1',
			Array.from({ length: 50 }, (_, index) =>
				entry(index + 51, assistant(`message-${index + 51}`)),
			),
			{ lastSeq: 100, pageOldestSeq: 51, hasMore: true },
		);
		vi.mocked(getChatMessages).mockResolvedValueOnce({
			chatId: 'chat-1',
			limit: 50,
			...page({
				messages: Array.from({ length: 50 }, (_, index) =>
					entry(index + 1, assistant(`message-${index + 1}`)),
				),
				lastSeq: 100,
				pageOldestSeq: 1,
				hasMore: false,
			}),
		});

		await chat.navigateToWindow('chat-1', 'initial');
		chat.setPendingUserInputs([
			{
				chatId: 'chat-1',
				clientRequestId: 'req-1',
				clientMessageId: 'msg-1',
				content: 'pending-tail',
				createdAt: '2026-06-01T00:00:01.000Z',
				deliveryStatus: 'accepted',
			},
		]);
		chat.appendLocalNotice('progress', 'tail-only status');
		expect(chat.visibleRows).toHaveLength(50);
		expect(chat.applyMessages('chat-1', 'generation-1', [entry(101, assistant('live-tail'))])).toBe(
			'applied',
		);

		expect(chat.visibleRows).toHaveLength(50);
		expect(chat.visibleRows.at(-1)).toMatchObject({ kind: 'message', seq: 50 });
		expect(chat.getCursor()).toEqual({ generationId: 'generation-1', lastSeq: 101 });
		expect(chat.transcriptCache.get('chat-1')?.messages.at(-1)).toMatchObject({ seq: 101 });

		vi.mocked(getChatMessages).mockResolvedValueOnce({
			chatId: 'chat-1',
			limit: 50,
			...page({
				messages: Array.from({ length: 50 }, (_, index) =>
					entry(index + 52, assistant(`message-${index + 52}`)),
				),
				lastSeq: 101,
				pageOldestSeq: 52,
				hasMore: true,
			}),
		});
		await chat.navigateToWindow('chat-1', 'latest');

		expect(chat.hasLaterMessages).toBe(false);
		expect(chat.visibleRows.at(-1)).toMatchObject({ kind: 'message', seq: 101 });
	});

	it('replays live messages that arrive while restoring the latest window', async () => {
		const chat = new ActiveTranscriptState();
		chat.replaceGeneration(
			'chat-1',
			'generation-1',
			Array.from({ length: 50 }, (_, index) =>
				entry(index + 51, assistant(`latest-${index + 51}`)),
			),
			{ lastSeq: 100, pageOldestSeq: 51, hasMore: true },
		);
		chat.entries = Array.from({ length: 50 }, (_, index) =>
			entry(index + 1, assistant(`initial-${index + 1}`)),
		);
		chat.oldestSeq = 1;
		chat.hasEarlierMessages = false;
		chat.visibleMessageCount = 50;
		let resolveLatest!: (value: Awaited<ReturnType<typeof getChatMessages>>) => void;
		vi.mocked(getChatMessages).mockReturnValueOnce(
			new Promise((resolve) => {
				resolveLatest = resolve;
			}),
		);

		const latest = chat.navigateToWindow('chat-1', 'latest');
		expect(chat.applyMessages('chat-1', 'generation-1', [entry(101, assistant('live'))])).toBe(
			'applied',
		);
		resolveLatest({
			chatId: 'chat-1',
			limit: 50,
			...page({
				messages: Array.from({ length: 50 }, (_, index) =>
					entry(index + 51, assistant(`latest-${index + 51}`)),
				),
				lastSeq: 100,
				pageOldestSeq: 51,
				hasMore: true,
			}),
		});

		await expect(latest).resolves.toBe('loaded');
		expect(chat.entries.at(-1)).toMatchObject({ seq: 101, message: { content: 'live' } });
		expect(chat.transcriptCache.get('chat-1')?.messages.at(-1)).toMatchObject({ seq: 101 });
		expect(chat.getCursor()).toEqual({ generationId: 'generation-1', lastSeq: 101 });
	});

	it.each([
		{
			name: 'add',
			mutate: (chat: ActiveTranscriptState) =>
				chat.upsertPendingUserInput(
					pendingInput({
						clientRequestId: 'req-2',
						clientMessageId: 'msg-2',
						content: 'added',
						createdAt: '2026-06-01T00:00:01.000Z',
					}),
				),
			expected: [
				pendingInput(),
				pendingInput({
					clientRequestId: 'req-2',
					clientMessageId: 'msg-2',
					content: 'added',
					createdAt: '2026-06-01T00:00:01.000Z',
				}),
			],
		},
		{
			name: 'update',
			mutate: (chat: ActiveTranscriptState) =>
				chat.upsertPendingUserInput(pendingInput({ content: 'updated' })),
			expected: [pendingInput({ content: 'updated' })],
		},
		{
			name: 'clear',
			mutate: (chat: ActiveTranscriptState) => chat.clearPendingUserInput('req-1'),
			expected: [],
		},
		{
			name: 'status update',
			mutate: (chat: ActiveTranscriptState) =>
				chat.updatePendingUserInputDeliveryStatus('req-1', 'failed'),
			expected: [pendingInput({ deliveryStatus: 'failed' })],
		},
	])(
		'preserves a pending-input $name while restoring the latest window',
		async ({ mutate, expected }) => {
			const chat = new ActiveTranscriptState();
			chat.replaceGeneration(
				'chat-1',
				'generation-1',
				Array.from({ length: 50 }, (_, index) =>
					entry(index + 51, assistant(`latest-${index + 51}`)),
				),
				{
					lastSeq: 100,
					pageOldestSeq: 51,
					hasMore: true,
					pendingUserInputs: [pendingInput()],
				},
			);
			chat.entries = Array.from({ length: 50 }, (_, index) =>
				entry(index + 1, assistant(`initial-${index + 1}`)),
			);
			chat.oldestSeq = 1;
			chat.hasEarlierMessages = false;
			chat.visibleMessageCount = 50;
			let resolveLatest!: (value: Awaited<ReturnType<typeof getChatMessages>>) => void;
			vi.mocked(getChatMessages).mockReturnValueOnce(
				new Promise((resolve) => {
					resolveLatest = resolve;
				}),
			);

			const latest = chat.navigateToWindow('chat-1', 'latest');
			mutate(chat);
			resolveLatest({
				chatId: 'chat-1',
				limit: 50,
				...page({
					messages: Array.from({ length: 50 }, (_, index) =>
						entry(index + 51, assistant(`latest-${index + 51}`)),
					),
					lastSeq: 100,
					pageOldestSeq: 51,
					hasMore: true,
					pendingUserInputs: [pendingInput()],
				}),
			});

			await expect(latest).resolves.toBe('loaded');
			expect(chat.pendingUserInputs).toEqual(expected);
		},
	);

	it('discards an earlier page invalidated by explicit navigation', async () => {
		const chat = new ActiveTranscriptState();
		const latestWindow = Array.from({ length: 50 }, (_, index) =>
			entry(index + 51, assistant(`message-${index + 51}`)),
		);
		chat.replaceGeneration('chat-1', 'generation-1', latestWindow, {
			lastSeq: 100,
			pageOldestSeq: 51,
			hasMore: true,
		});
		let resolvePage!: (value: Awaited<ReturnType<typeof getChatMessages>>) => void;
		vi.mocked(getChatMessages).mockReturnValueOnce(
			new Promise((resolve) => {
				resolvePage = resolve;
			}),
		);

		const load = chat.loadEarlierPage('chat-1');
		chat.invalidatePendingHistoryLoad();
		resolvePage({
			chatId: 'chat-1',
			limit: 50,
			...page({
				messages: Array.from({ length: 50 }, (_, index) =>
					entry(index + 1, assistant(`message-${index + 1}`)),
				),
				lastSeq: 100,
				pageOldestSeq: 1,
				hasMore: false,
			}),
		});

		await expect(load).resolves.toBe('invalidated');
		expect(chat.chatMessages.map(contentOf)).toEqual(
			Array.from({ length: 50 }, (_, index) => `message-${index + 51}`),
		);
		expect(chat.hasEarlierMessages).toBe(true);
	});

	it('does not replace another chat when an initial-page request settles', async () => {
		const transcriptCache = new ChatTranscriptCache({ limit: 100 });
		transcriptCache.replaceFromPage('chat-2', {
			generationId: 'generation-2',
			messages: Array.from({ length: 30 }, (_, index) =>
				entry(index + 1, assistant(`chat-2-message-${index + 1}`)),
			),
			lastSeq: 30,
			pageOldestSeq: 1,
			hasMore: false,
		});
		const chat = new ActiveTranscriptState(transcriptCache);
		chat.replaceGeneration(
			'chat-1',
			'generation-1',
			Array.from({ length: 50 }, (_, index) =>
				entry(index + 51, assistant(`chat-1-message-${index + 51}`)),
			),
			{ lastSeq: 100, pageOldestSeq: 51, hasMore: true },
		);
		let resolvePage!: (value: Awaited<ReturnType<typeof getChatMessages>>) => void;
		vi.mocked(getChatMessages).mockReturnValueOnce(
			new Promise((resolve) => {
				resolvePage = resolve;
			}),
		);

		const initialLoad = chat.navigateToWindow('chat-1', 'initial');
		expect(getChatMessages).toHaveBeenCalledOnce();
		chat.activateChat('chat-2');
		expect(chat.visibleRows).toHaveLength(20);
		expect(chat.hasInitialMessagesToReveal).toBe(true);

		resolvePage({
			chatId: 'chat-1',
			limit: 50,
			...page({
				messages: Array.from({ length: 50 }, (_, index) =>
					entry(index + 1, assistant(`chat-1-message-${index + 1}`)),
				),
				lastSeq: 100,
				pageOldestSeq: 1,
				hasMore: false,
			}),
		});
		await expect(initialLoad).resolves.toBe('invalidated');

		expect(chat.activeChatId).toBe('chat-2');
		expect(chat.visibleRows).toHaveLength(20);
		expect(chat.hasInitialMessagesToReveal).toBe(true);
	});

	it('lets a new chat paginate while the previous chat page request is still pending', async () => {
		const chat = new ActiveTranscriptState();
		chat.replaceGeneration(
			'chat-1',
			'generation-1',
			Array.from({ length: 50 }, (_, index) =>
				entry(index + 51, assistant(`chat-1-message-${index + 51}`)),
			),
			{ lastSeq: 100, pageOldestSeq: 51, hasMore: true },
		);
		let resolveOldPage!: (value: Awaited<ReturnType<typeof getChatMessages>>) => void;
		let resolveNewPage!: (value: Awaited<ReturnType<typeof getChatMessages>>) => void;
		vi.mocked(getChatMessages)
			.mockReturnValueOnce(
				new Promise((resolve) => {
					resolveOldPage = resolve;
				}),
			)
			.mockReturnValueOnce(
				new Promise((resolve) => {
					resolveNewPage = resolve;
				}),
			);

		const oldLoad = chat.loadEarlierPage('chat-1');
		expect(chat.pageStates.earlier.status).toBe('loading');

		chat.activateChat('chat-2');
		expect(chat.pageStates.earlier.status).toBe('idle');
		chat.replaceGeneration(
			'chat-2',
			'generation-2',
			Array.from({ length: 50 }, (_, index) =>
				entry(index + 51, assistant(`chat-2-message-${index + 51}`)),
			),
			{ lastSeq: 100, pageOldestSeq: 51, hasMore: true },
		);
		expect(chat.pageStates.earlier.status).toBe('idle');

		const newLoad = chat.loadEarlierPage('chat-2');
		expect(chat.pageStates.earlier.status).toBe('loading');

		expect(getChatMessages).toHaveBeenCalledTimes(2);
		resolveOldPage({
			chatId: 'chat-1',
			limit: 50,
			...page({
				messages: Array.from({ length: 50 }, (_, index) =>
					entry(index + 1, assistant(`chat-1-message-${index + 1}`)),
				),
				lastSeq: 100,
				pageOldestSeq: 1,
				hasMore: false,
			}),
		});
		await expect(oldLoad).resolves.toBe('invalidated');

		expect(chat.activeChatId).toBe('chat-2');
		expect(chat.chatMessages[0]).toMatchObject({ content: 'chat-2-message-51' });
		expect(chat.pageStates.earlier.status).toBe('loading');

		resolveNewPage({
			chatId: 'chat-2',
			limit: 50,
			...page({
				generationId: 'generation-2',
				messages: Array.from({ length: 50 }, (_, index) =>
					entry(index + 1, assistant(`chat-2-message-${index + 1}`)),
				),
				lastSeq: 100,
				pageOldestSeq: 1,
				hasMore: false,
			}),
		});
		await expect(newLoad).resolves.toBe('loaded');

		expect(chat.chatMessages.map(contentOf)).toEqual(
			Array.from({ length: 100 }, (_, index) => `chat-2-message-${index + 1}`),
		);
		expect(chat.pageStates.earlier.status).toBe('idle');
	});

	it('loads a new chat initial page while the previous chat page request is pending', async () => {
		const chat = new ActiveTranscriptState();
		chat.replaceGeneration(
			'chat-1',
			'generation-1',
			Array.from({ length: 50 }, (_, index) =>
				entry(index + 51, assistant(`chat-1-message-${index + 51}`)),
			),
			{ lastSeq: 100, pageOldestSeq: 51, hasMore: true },
		);
		let resolveOldPage!: (value: Awaited<ReturnType<typeof getChatMessages>>) => void;
		vi.mocked(getChatMessages)
			.mockReturnValueOnce(
				new Promise((resolve) => {
					resolveOldPage = resolve;
				}),
			)
			.mockResolvedValueOnce({
				chatId: 'chat-2',
				limit: 50,
				...page({
					generationId: 'generation-2',
					messages: Array.from({ length: 50 }, (_, index) =>
						entry(index + 1, assistant(`chat-2-message-${index + 1}`)),
					),
					lastSeq: 100,
					pageOldestSeq: 1,
					hasMore: false,
				}),
			});

		const oldLoad = chat.loadEarlierPage('chat-1');
		chat.activateChat('chat-2');
		chat.replaceGeneration(
			'chat-2',
			'generation-2',
			Array.from({ length: 50 }, (_, index) =>
				entry(index + 51, assistant(`chat-2-message-${index + 51}`)),
			),
			{ lastSeq: 100, pageOldestSeq: 51, hasMore: true },
		);

		await expect(chat.navigateToWindow('chat-2', 'initial')).resolves.toBe('loaded');

		expect(getChatMessages).toHaveBeenCalledTimes(2);
		expect(chat.hasEarlierMessages).toBe(false);
		expect(chat.visibleRows).toHaveLength(50);
		expect(chat.visibleRows[0]).toMatchObject({ kind: 'message', seq: 1 });
		expect(chat.visibleRows.at(-1)).toMatchObject({ kind: 'message', seq: 50 });
		expect(chat.hasLaterMessages).toBe(true);
		expect(chat.pageStates.earlier.status).toBe('idle');

		resolveOldPage({
			chatId: 'chat-1',
			limit: 50,
			...page({
				messages: Array.from({ length: 50 }, (_, index) =>
					entry(index + 1, assistant(`chat-1-message-${index + 1}`)),
				),
				lastSeq: 100,
				pageOldestSeq: 1,
				hasMore: false,
			}),
		});
		await expect(oldLoad).resolves.toBe('invalidated');

		expect(chat.activeChatId).toBe('chat-2');
		expect(chat.visibleRows[0]).toMatchObject({ kind: 'message', seq: 1 });
		expect(chat.pageStates.earlier.status).toBe('idle');
	});

	it('rejects an old page after switching away and back to the same chat generation', async () => {
		const chat = new ActiveTranscriptState();
		const latestWindow = Array.from({ length: 50 }, (_, index) =>
			entry(index + 51, assistant(`chat-1-message-${index + 51}`)),
		);
		chat.replaceGeneration('chat-1', 'generation-1', latestWindow, {
			lastSeq: 100,
			pageOldestSeq: 51,
			hasMore: true,
		});
		let resolveOldPage!: (value: Awaited<ReturnType<typeof getChatMessages>>) => void;
		let resolveNewPage!: (value: Awaited<ReturnType<typeof getChatMessages>>) => void;
		vi.mocked(getChatMessages)
			.mockReturnValueOnce(
				new Promise((resolve) => {
					resolveOldPage = resolve;
				}),
			)
			.mockReturnValueOnce(
				new Promise((resolve) => {
					resolveNewPage = resolve;
				}),
			);

		const oldLoad = chat.loadEarlierPage('chat-1');
		chat.activateChat('chat-2');
		chat.replaceGeneration('chat-2', 'generation-2', [entry(1, assistant('chat-2'))], {
			lastSeq: 1,
			pageOldestSeq: 1,
			hasMore: false,
		});
		chat.activateChat('chat-1');
		chat.replaceGeneration('chat-1', 'generation-1', latestWindow, {
			lastSeq: 100,
			pageOldestSeq: 51,
			hasMore: true,
		});
		const newLoad = chat.loadEarlierPage('chat-1');

		expect(getChatMessages).toHaveBeenCalledTimes(2);
		resolveOldPage({
			chatId: 'chat-1',
			limit: 50,
			...page({
				messages: Array.from({ length: 50 }, (_, index) =>
					entry(index + 1, assistant(`old-page-${index + 1}`)),
				),
				lastSeq: 100,
				pageOldestSeq: 1,
				hasMore: false,
			}),
		});
		await expect(oldLoad).resolves.toBe('invalidated');

		expect(chat.chatMessages.map(contentOf)).toEqual(
			Array.from({ length: 50 }, (_, index) => `chat-1-message-${index + 51}`),
		);
		expect(chat.pageStates.earlier.status).toBe('loading');

		resolveNewPage({
			chatId: 'chat-1',
			limit: 50,
			...page({
				messages: Array.from({ length: 50 }, (_, index) =>
					entry(index + 1, assistant(`chat-1-message-${index + 1}`)),
				),
				lastSeq: 100,
				pageOldestSeq: 1,
				hasMore: false,
			}),
		});
		await expect(newLoad).resolves.toBe('loaded');

		expect(chat.chatMessages.map(contentOf)).toEqual(
			Array.from({ length: 100 }, (_, index) => `chat-1-message-${index + 1}`),
		);
		expect(chat.pageStates.earlier.status).toBe('idle');
	});

	it('does not share or apply a page request from a replaced generation', async () => {
		const chat = new ActiveTranscriptState();
		chat.replaceGeneration(
			'chat-1',
			'generation-1',
			Array.from({ length: 50 }, (_, index) =>
				entry(index + 51, assistant(`generation-1-message-${index + 51}`)),
			),
			{ lastSeq: 100, pageOldestSeq: 51, hasMore: true },
		);
		let resolveOldPage!: (value: Awaited<ReturnType<typeof getChatMessages>>) => void;
		let resolveNewPage!: (value: Awaited<ReturnType<typeof getChatMessages>>) => void;
		vi.mocked(getChatMessages)
			.mockReturnValueOnce(
				new Promise((resolve) => {
					resolveOldPage = resolve;
				}),
			)
			.mockReturnValueOnce(
				new Promise((resolve) => {
					resolveNewPage = resolve;
				}),
			);

		const oldLoad = chat.loadEarlierPage('chat-1');
		chat.replaceGeneration(
			'chat-1',
			'generation-2',
			Array.from({ length: 50 }, (_, index) =>
				entry(index + 51, assistant(`generation-2-message-${index + 51}`)),
			),
			{ lastSeq: 100, pageOldestSeq: 51, hasMore: true },
		);
		const newLoad = chat.loadEarlierPage('chat-1');

		expect(getChatMessages).toHaveBeenCalledTimes(2);
		resolveOldPage({
			chatId: 'chat-1',
			limit: 50,
			...page({
				generationId: 'generation-1',
				messages: Array.from({ length: 50 }, (_, index) =>
					entry(index + 1, assistant(`generation-1-message-${index + 1}`)),
				),
				lastSeq: 100,
				pageOldestSeq: 1,
				hasMore: false,
			}),
		});
		await expect(oldLoad).resolves.toBe('invalidated');

		expect(chat.generationId).toBe('generation-2');
		expect(chat.chatMessages[0]).toMatchObject({ content: 'generation-2-message-51' });
		expect(chat.pageStates.earlier.status).toBe('loading');

		resolveNewPage({
			chatId: 'chat-1',
			limit: 50,
			...page({
				generationId: 'generation-2',
				messages: Array.from({ length: 50 }, (_, index) =>
					entry(index + 1, assistant(`generation-2-message-${index + 1}`)),
				),
				lastSeq: 100,
				pageOldestSeq: 1,
				hasMore: false,
			}),
		});
		await expect(newLoad).resolves.toBe('loaded');

		expect(chat.chatMessages.map(contentOf)).toEqual(
			Array.from({ length: 100 }, (_, index) => `generation-2-message-${index + 1}`),
		);
		expect(chat.pageStates.earlier.status).toBe('idle');
	});

	it('detaches an earlier-page request when a buffered batch changes generation', async () => {
		const chat = new ActiveTranscriptState();
		const latestWindow = Array.from({ length: 50 }, (_, index) =>
			entry(index + 51, assistant(`message-${index + 51}`)),
		);
		chat.replaceGeneration('chat-1', 'generation-1', latestWindow, {
			lastSeq: 100,
			pageOldestSeq: 51,
			hasMore: true,
		});
		let resolveOldPage!: (value: Awaited<ReturnType<typeof getChatMessages>>) => void;
		let resolveNewPage!: (value: Awaited<ReturnType<typeof getChatMessages>>) => void;
		vi.mocked(getChatMessages)
			.mockReturnValueOnce(
				new Promise((resolve) => {
					resolveOldPage = resolve;
				}),
			)
			.mockReturnValueOnce(
				new Promise((resolve) => {
					resolveNewPage = resolve;
				}),
			);

		const oldLoad = chat.loadEarlierPage('chat-1');
		const snapshotEpoch = chat.beginSnapshotLoad();
		chat.applyMessages('chat-1', 'generation-2', [entry(1, assistant('new generation'))]);

		expect(
			chat.setFromPage(
				'chat-1',
				page({
					generationId: 'generation-1',
					messages: latestWindow,
					lastSeq: 100,
					pageOldestSeq: 51,
					hasMore: true,
				}),
				snapshotEpoch,
			),
		).toBe('generation-changed');
		expect(chat.pageStates.earlier.status).toBe('idle');

		const newLoad = chat.loadEarlierPage('chat-1');
		expect(getChatMessages).toHaveBeenCalledTimes(2);

		resolveOldPage({
			chatId: 'chat-1',
			limit: 50,
			...page({
				messages: Array.from({ length: 50 }, (_, index) =>
					entry(index + 1, assistant(`stale-${index + 1}`)),
				),
				lastSeq: 100,
				pageOldestSeq: 1,
				hasMore: false,
			}),
		});
		await expect(oldLoad).resolves.toBe('invalidated');

		expect(chat.chatMessages.map(contentOf)).toEqual(
			Array.from({ length: 50 }, (_, index) => `message-${index + 51}`),
		);
		expect(chat.pageStates.earlier.status).toBe('loading');

		resolveNewPage({
			chatId: 'chat-1',
			limit: 50,
			...page({
				messages: [],
				lastSeq: 100,
				pageOldestSeq: 0,
				hasMore: false,
			}),
		});
		await expect(newLoad).resolves.toBe('exhausted');
		expect(chat.pageStates.earlier.status).toBe('idle');
	});

	it('keeps loaded earlier selected messages while the shared cache stays windowed', () => {
		const transcriptCache = new ChatTranscriptCache({ limit: 2 });
		const chat = new ActiveTranscriptState(transcriptCache);

		chat.replaceGeneration(
			'chat-1',
			'generation-1',
			[entry(1, user('first')), entry(2, assistant('second')), entry(3, assistant('third'))],
			{ lastSeq: 3, pageOldestSeq: 1, hasMore: false },
		);

		expect(transcriptCache.get('chat-1')?.messages.map((item) => item.seq)).toEqual([2, 3]);

		const result = chat.applyMessages('chat-1', 'generation-1', [entry(4, assistant('fourth'))]);

		expect(result).toBe('applied');
		expect(chat.chatMessages.map(contentOf)).toEqual(['first', 'second', 'third', 'fourth']);
		expect(transcriptCache.get('chat-1')?.messages.map((item) => item.seq)).toEqual([3, 4]);
	});
});
