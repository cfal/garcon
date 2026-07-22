import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
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

describe('ActiveTranscriptState', () => {
	beforeEach(() => {
		localStorage.clear();
		vi.mocked(getChatMessages).mockReset();
	});

	it('starts with an empty generation cursor', () => {
		const chat = new ActiveTranscriptState();

		expect(chat.getCursor()).toEqual({ generationId: '', lastSeq: 0 });
		expect(chat.chatMessages).toEqual([]);
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
				images: [{
					name: 'context.pdf',
					mimeType: 'application/octet-stream',
					data: '',
				}],
				metadata: { deliveryStatus: 'failed' },
			});
		});

		it('projects a failed pending status onto its durable user row without duplication', () => {
			const chat = new ActiveTranscriptState();
			chat.applyMessages('chat-1', 'generation-1', [
				entry(1, user('pending', {
					clientRequestId: 'req-1',
					deliveryStatus: 'accepted',
				})),
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
				entry(1, user('pending', {
					clientRequestId: 'req-1',
					deliveryStatus: 'accepted',
				})),
			]);
			chat.setPendingUserInputs([{
				chatId: 'chat-1',
				clientRequestId: 'req-1',
				content: 'pending',
				createdAt: TS,
				deliveryStatus: 'unconfirmed',
			}]);

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

	it('reveals every already-loaded row for explicit navigation', () => {
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

	it('shares an in-flight earlier-page request with load-all', async () => {
		const chat = new ActiveTranscriptState();
		chat.replaceGeneration(
			'chat-1',
			'generation-1',
			Array.from({ length: 50 }, (_, index) =>
				entry(index + 51, assistant(`message-${index + 51}`)),
			),
			{ lastSeq: 100, pageOldestSeq: 51, hasMore: true },
		);
		let resolvePage!: (value: Awaited<ReturnType<typeof getChatMessages>>) => void;
		vi.mocked(getChatMessages).mockReturnValueOnce(
			new Promise((resolve) => {
				resolvePage = resolve;
			}),
		);

		const firstLoad = chat.loadMoreMessages('chat-1');
		const loadAll = chat.loadAllMessages('chat-1');

		expect(getChatMessages).toHaveBeenCalledOnce();
		resolvePage(
			{
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
			},
		);

		await expect(firstLoad).resolves.toBe(true);
		await loadAll;

		expect(getChatMessages).toHaveBeenCalledOnce();
		expect(chat.visibleRows).toHaveLength(100);
		expect(chat.hasMoreMessages).toBe(false);
	});

	it('does not complete another chat reveal when an old load-all request settles', async () => {
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

		const loadAll = chat.loadAllMessages('chat-1');
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
		await loadAll;

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

		const oldLoad = chat.loadMoreMessages('chat-1');
		expect(chat.isLoadingMoreMessages).toBe(true);

		chat.activateChat('chat-2');
		expect(chat.isLoadingMoreMessages).toBe(false);
		chat.replaceGeneration(
			'chat-2',
			'generation-2',
			Array.from({ length: 50 }, (_, index) =>
				entry(index + 51, assistant(`chat-2-message-${index + 51}`)),
			),
			{ lastSeq: 100, pageOldestSeq: 51, hasMore: true },
		);
		expect(chat.isLoadingMoreMessages).toBe(false);

		const newLoad = chat.loadMoreMessages('chat-2');
		expect(chat.isLoadingMoreMessages).toBe(true);

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
		await expect(oldLoad).resolves.toBe(false);

		expect(chat.activeChatId).toBe('chat-2');
		expect(chat.chatMessages[0]).toMatchObject({ content: 'chat-2-message-51' });
		expect(chat.isLoadingMoreMessages).toBe(true);

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
		await expect(newLoad).resolves.toBe(true);

		expect(chat.chatMessages.map(contentOf)).toEqual(
			Array.from({ length: 100 }, (_, index) => `chat-2-message-${index + 1}`),
		);
		expect(chat.isLoadingMoreMessages).toBe(false);
	});

	it('loads a new chat to its true top while the previous chat page request is pending', async () => {
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

		const oldLoad = chat.loadMoreMessages('chat-1');
		chat.activateChat('chat-2');
		chat.replaceGeneration(
			'chat-2',
			'generation-2',
			Array.from({ length: 50 }, (_, index) =>
				entry(index + 51, assistant(`chat-2-message-${index + 51}`)),
			),
			{ lastSeq: 100, pageOldestSeq: 51, hasMore: true },
		);

		await chat.loadAllMessages('chat-2');

		expect(getChatMessages).toHaveBeenCalledTimes(2);
		expect(chat.hasMoreMessages).toBe(false);
		expect(chat.visibleRows).toHaveLength(100);
		expect(chat.visibleRows[0]).toMatchObject({ kind: 'message', seq: 1 });
		expect(chat.isLoadingMoreMessages).toBe(false);

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
		await expect(oldLoad).resolves.toBe(false);

		expect(chat.activeChatId).toBe('chat-2');
		expect(chat.visibleRows[0]).toMatchObject({ kind: 'message', seq: 1 });
		expect(chat.isLoadingMoreMessages).toBe(false);
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

		const oldLoad = chat.loadMoreMessages('chat-1');
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
		const newLoad = chat.loadMoreMessages('chat-1');

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
		await expect(oldLoad).resolves.toBe(false);

		expect(chat.chatMessages.map(contentOf)).toEqual(
			Array.from({ length: 50 }, (_, index) => `chat-1-message-${index + 51}`),
		);
		expect(chat.isLoadingMoreMessages).toBe(true);

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
		await expect(newLoad).resolves.toBe(true);

		expect(chat.chatMessages.map(contentOf)).toEqual(
			Array.from({ length: 100 }, (_, index) => `chat-1-message-${index + 1}`),
		);
		expect(chat.isLoadingMoreMessages).toBe(false);
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

		const oldLoad = chat.loadMoreMessages('chat-1');
		chat.replaceGeneration(
			'chat-1',
			'generation-2',
			Array.from({ length: 50 }, (_, index) =>
				entry(index + 51, assistant(`generation-2-message-${index + 51}`)),
			),
			{ lastSeq: 100, pageOldestSeq: 51, hasMore: true },
		);
		const newLoad = chat.loadMoreMessages('chat-1');

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
		await expect(oldLoad).resolves.toBe(false);

		expect(chat.generationId).toBe('generation-2');
		expect(chat.chatMessages[0]).toMatchObject({ content: 'generation-2-message-51' });
		expect(chat.isLoadingMoreMessages).toBe(true);

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
		await expect(newLoad).resolves.toBe(true);

		expect(chat.chatMessages.map(contentOf)).toEqual(
			Array.from({ length: 100 }, (_, index) => `generation-2-message-${index + 1}`),
		);
		expect(chat.isLoadingMoreMessages).toBe(false);
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

		const oldLoad = chat.loadMoreMessages('chat-1');
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
		expect(chat.isLoadingMoreMessages).toBe(false);

		const newLoad = chat.loadMoreMessages('chat-1');
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
		await expect(oldLoad).resolves.toBe(false);

		expect(chat.chatMessages.map(contentOf)).toEqual(
			Array.from({ length: 50 }, (_, index) => `message-${index + 51}`),
		);
		expect(chat.isLoadingMoreMessages).toBe(true);

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
		await expect(newLoad).resolves.toBe(false);
		expect(chat.isLoadingMoreMessages).toBe(false);
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
