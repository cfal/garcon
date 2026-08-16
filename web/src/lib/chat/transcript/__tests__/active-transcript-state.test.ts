import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	ActiveTranscriptState,
	INITIAL_VISIBLE_MESSAGES,
} from '../active-transcript-state.svelte.js';
import { ACTIVE_TRANSCRIPT_RETENTION_LIMIT } from '../transcript-page-progress.js';
import { ChatTranscriptCache } from '../chat-transcript-cache.svelte';
import {
	AssistantMessage,
	BashToolUseMessage,
	UserMessage,
	type ChatMessage,
} from '$shared/chat-types';
import type { ResendCandidate, TranscriptMessage } from '$shared/chat-view';
import { getChatMessages } from '$lib/api/chats.js';
import type { ChatDisplayRow } from '../active-transcript-state.svelte.js';
import type { OptimisticUserInput } from '../optimistic-user-input.js';

vi.mock('$lib/api/chats.js', () => ({
	getChatMessages: vi.fn(),
}));

const TS = '2026-06-01T00:00:00.000Z';

function entry(ordinal: number, message: ChatMessage): TranscriptMessage {
	return { ordinal, message };
}

function applyMessages(
	chat: ActiveTranscriptState,
	chatId: string,
	transcriptViewId: string,
	messages: TranscriptMessage[],
	firstOrdinal = messages[0]?.ordinal ?? 1,
	lastOrdinal = messages.at(-1)?.ordinal ?? firstOrdinal - 1,
) {
	return chat.applyMessages(chatId, transcriptViewId, messages, firstOrdinal, lastOrdinal);
}

function user(content: string, metadata: Record<string, unknown> = {}) {
	return new UserMessage(TS, content, undefined, metadata);
}

function assistant(content: string) {
	return new AssistantMessage(TS, content);
}

function assistantEntries(
	firstOrdinal: number,
	lastOrdinal: number,
	content: (ordinal: number) => string = (ordinal) => `message-${ordinal}`,
): TranscriptMessage[] {
	return Array.from({ length: lastOrdinal - firstOrdinal + 1 }, (_, index) => {
		const ordinal = firstOrdinal + index;
		return entry(ordinal, assistant(content(ordinal)));
	});
}

function contentOf(message: ChatMessage): string {
	return 'content' in message ? String(message.content) : '';
}

function rowContentOf(row: ChatDisplayRow): string {
	return row.kind === 'local-notice' ? row.content : contentOf(row.message);
}

function page(
	overrides: Partial<{
		transcriptViewId: string;
		messages: TranscriptMessage[];
		lastOrdinal: number;
		pageOldestOrdinal: number;
		pageNewestOrdinal: number;
		hasMore: boolean;
		resendCandidates: ResendCandidate[];
	}> = {},
) {
	const messages = overrides.messages ?? [entry(1, assistant('hello'))];
	return {
		historyState: { kind: 'complete' as const },
		transcriptViewId: overrides.transcriptViewId ?? 'generation-1',
		messages,
		lastOrdinal: overrides.lastOrdinal ?? messages.at(-1)?.ordinal ?? 0,
		pageOldestOrdinal: overrides.pageOldestOrdinal ?? messages[0]?.ordinal ?? 0,
		pageNewestOrdinal: overrides.pageNewestOrdinal ?? messages.at(-1)?.ordinal
			?? overrides.lastOrdinal
			?? 0,
		hasMore: overrides.hasMore ?? false,
		resendCandidates: overrides.resendCandidates ?? [],
	};
}

function optimisticInput(overrides: Partial<OptimisticUserInput> = {}): OptimisticUserInput {
	return {
		chatId: 'chat-1',
		clientMessageId: 'msg-1',
		content: 'optimistic',
		createdAt: TS,
		delivery: 'pending',
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

		expect(chat.getCursor()).toEqual({ transcriptViewId: '', lastOrdinal: 0 });
		expect(chat.chatMessages).toEqual([]);
		expect(chat.feedMutationClock.dataRevision).toBe(0);
	});

	it('keeps resend opt-outs ephemeral and prunes them with the candidate set', () => {
		const chat = new ActiveTranscriptState();
		chat.setResendCandidates([
			{ ordinal: 1, content: 'first', attachmentNames: [] },
			{ ordinal: 2, content: 'second', attachmentNames: ['image.png'] },
		]);

		chat.excludeResendCandidate(1);
		expect(chat.resendCandidates.map((candidate) => candidate.ordinal)).toEqual([2]);
		expect(chat.excludedResendOrdinals).toEqual([1]);

		chat.setResendCandidates([{ ordinal: 2, content: 'second', attachmentNames: [] }]);
		expect(chat.excludedResendOrdinals).toEqual([]);
		chat.clearResendExclusions();
		expect(chat.resendCandidates.map((candidate) => candidate.ordinal)).toEqual([2]);
	});

	it('renders degraded history without retaining sequence or cache state', async () => {
		const transcriptCache = new ChatTranscriptCache({ limit: 50 });
		transcriptCache.replace(
			'chat-1',
			'generation-old',
			[entry(1, assistant('stale'))],
			1,
		);
		vi.mocked(getChatMessages).mockResolvedValueOnce({
			historyState: {
				kind: 'degraded',
				errorCode: 'CARRYOVER_HISTORY_UNAVAILABLE',
				retryable: false,
			},
			chatId: 'chat-1',
			messages: [],
		});
		const chat = new ActiveTranscriptState(transcriptCache);

		await chat.loadMessages('chat-1');

		expect(chat.historyState).toEqual({
			kind: 'degraded',
			errorCode: 'CARRYOVER_HISTORY_UNAVAILABLE',
			retryable: false,
		});
		expect(chat.getCursor()).toEqual({ transcriptViewId: '', lastOrdinal: 0 });
		expect(chat.entries).toEqual([]);
		expect(chat.optimisticUserInputs).toEqual([]);
		expect(chat.visibleRows).toEqual([
			expect.objectContaining({ kind: 'local-notice', noticeType: 'error' }),
		]);
		expect(transcriptCache.get('chat-1')).toBeNull();
		expect(applyMessages(chat, 'chat-1', 'generation-new', [entry(1, assistant('ignored'))]))
			.toBe('gap-detected');
	});

	it('records applied feed mutations by provenance without counting duplicates', () => {
		const chat = new ActiveTranscriptState();

		applyMessages(chat, 'chat-1', 'generation-1', [entry(1, assistant('hello'))]);
		const liveRevision = chat.feedMutationClock.dataRevision;
		expect(chat.feedMutationClock.lastRevisionByKind['live-append']).toBe(liveRevision);
		expect(chat.feedMutationClock.lastResponseRevisionByMessageType).toEqual({
			'assistant-message': liveRevision,
		});

		const entriesBeforeDuplicate = chat.entries;
		const rowsBeforeDuplicate = chat.visibleRows;
		applyMessages(chat, 'chat-1', 'generation-1', [entry(1, assistant('duplicate'))]);
		expect(chat.feedMutationClock.dataRevision).toBe(liveRevision);
		expect(chat.entries).toBe(entriesBeforeDuplicate);
		expect(chat.visibleRows).toBe(rowsBeforeDuplicate);
		applyMessages(chat, 'chat-1', 'generation-1', [entry(2, user('next prompt'))]);
		expect(chat.feedMutationClock.lastResponseRevisionByMessageType).toEqual({
			'assistant-message': liveRevision,
		});
		applyMessages(chat, 'chat-1', 'generation-1', [
			entry(3, new BashToolUseMessage(TS, 'tool-1', 'pwd')),
		]);
		const toolRevision = chat.feedMutationClock.dataRevision;
		expect(chat.feedMutationClock.lastResponseRevisionByMessageType).toEqual({
			'assistant-message': liveRevision,
			'bash-tool-use': toolRevision,
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

	it('applies same-generation messages by ordinal and ignores duplicates', () => {
		const chat = new ActiveTranscriptState();

		expect(
			applyMessages(chat, 'chat-1', 'generation-1', [
				entry(1, user('hello')),
				entry(2, assistant('hi')),
			]),
		).toBe('applied');
		expect(
			applyMessages(chat, 'chat-1', 'generation-1', [
				entry(2, assistant('duplicate')),
				entry(3, assistant('next')),
			]),
		).toBe('applied');

		expect(chat.chatMessages.map(contentOf)).toEqual(['hello', 'hi', 'next']);
		expect(chat.getCursor()).toEqual({ transcriptViewId: 'generation-1', lastOrdinal: 3 });
	});

	it('retains a bottom-pinned live transcript until explicit compaction', () => {
		const chat = new ActiveTranscriptState();
		const messageCount = ACTIVE_TRANSCRIPT_RETENTION_LIMIT + 51;

		applyMessages(chat,
			'chat-1',
			'generation-1',
			Array.from({ length: messageCount }, (_, index) =>
				entry(index + 1, assistant(`message-${index + 1}`)),
			),
		);

		expect(chat.chatMessages).toHaveLength(messageCount);
		expect(contentOf(chat.chatMessages[0])).toBe('message-1');
		expect(chat.getCursor()).toEqual({ transcriptViewId: 'generation-1', lastOrdinal: messageCount });
		expect(chat.oldestOrdinal).toBe(1);
		expect(chat.hasEarlierMessages).toBe(false);
		expect(chat.hasLaterMessages).toBe(false);
		expect(chat.visibleRows).toHaveLength(INITIAL_VISIBLE_MESSAGES);

		expect(chat.compactToRecentMessages()).toBe(true);
		expect(chat.entries.map((message) => message.ordinal)).toEqual(
			Array.from({ length: ACTIVE_TRANSCRIPT_RETENTION_LIMIT }, (_, index) => index + 52),
		);
	});

	it('bounds oversized generation replacements to the recent message window', () => {
		const chat = new ActiveTranscriptState();
		const messageCount = ACTIVE_TRANSCRIPT_RETENTION_LIMIT + 25;
		const messages = Array.from({ length: messageCount }, (_, index) =>
			entry(index + 1, assistant(`message-${index + 1}`)),
		);

		chat.replaceGeneration('chat-1', 'generation-1', messages, {
			lastOrdinal: messageCount,
			pageOldestOrdinal: 1,
			hasMore: false,
		});

		expect(chat.entries).toHaveLength(ACTIVE_TRANSCRIPT_RETENTION_LIMIT);
		expect(chat.entries[0]?.ordinal).toBe(26);
		expect(chat.entries.at(-1)?.ordinal).toBe(messageCount);
		expect(chat.oldestOrdinal).toBe(26);
		expect(chat.hasEarlierMessages).toBe(true);
	});

	it('bounds oversized snapshot pages to the recent message window', () => {
		const chat = new ActiveTranscriptState();
		const messageCount = ACTIVE_TRANSCRIPT_RETENTION_LIMIT + 25;
		const messages = Array.from({ length: messageCount }, (_, index) =>
			entry(index + 1, assistant(`message-${index + 1}`)),
		);
		const epoch = chat.beginSnapshotLoad();

		expect(
			chat.setFromPage(
				'chat-1',
				page({ messages, lastOrdinal: messageCount, pageOldestOrdinal: 1 }),
				epoch,
			),
		).toBe('applied');
		expect(chat.entries).toHaveLength(ACTIVE_TRANSCRIPT_RETENTION_LIMIT);
		expect(chat.entries[0]?.ordinal).toBe(26);
		expect(chat.entries.at(-1)?.ordinal).toBe(messageCount);
		expect(chat.oldestOrdinal).toBe(26);
		expect(chat.hasEarlierMessages).toBe(true);
	});

	it('retains expanded live-edge history until explicit compaction', () => {
		const chat = new ActiveTranscriptState();
		const initial = Array.from({ length: ACTIVE_TRANSCRIPT_RETENTION_LIMIT }, (_, index) =>
			entry(index + 1, assistant(`message-${index + 1}`)),
		);
		chat.replaceGeneration('chat-1', 'generation-1', initial, {
			lastOrdinal: ACTIVE_TRANSCRIPT_RETENTION_LIMIT,
			pageOldestOrdinal: 1,
			hasMore: false,
		});
		chat.visibleMessageCount = INITIAL_VISIBLE_MESSAGES + 50;
		chat.isUserScrolledUp = false;

		applyMessages(chat,
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
		expect(contentOf(chat.chatMessages[0])).toBe('message-1');
		expect(chat.visibleMessageCount).toBe(INITIAL_VISIBLE_MESSAGES + 50);
		expect(chat.oldestOrdinal).toBe(1);
		expect(chat.hasEarlierMessages).toBe(false);

		expect(chat.compactToRecentMessages()).toBe(true);
		expect(chat.entries[0]?.ordinal).toBe(51);
		expect(chat.entries.at(-1)?.ordinal).toBe(ACTIVE_TRANSCRIPT_RETENTION_LIMIT + 50);
	});

	it('preserves both loaded edges while detached live history grows', () => {
		const chat = new ActiveTranscriptState();
		const initial = Array.from({ length: ACTIVE_TRANSCRIPT_RETENTION_LIMIT }, (_, index) =>
			entry(index + 1, assistant(`message-${index + 1}`)),
		);
		chat.replaceGeneration('chat-1', 'generation-1', initial, {
			lastOrdinal: ACTIVE_TRANSCRIPT_RETENTION_LIMIT,
			pageOldestOrdinal: 1,
			hasMore: false,
		});
		chat.isUserScrolledUp = true;

		applyMessages(chat,
			'chat-1',
			'generation-1',
			Array.from({ length: 50 }, (_, index) =>
				entry(
					ACTIVE_TRANSCRIPT_RETENTION_LIMIT + index + 1,
					assistant(`message-${ACTIVE_TRANSCRIPT_RETENTION_LIMIT + index + 1}`),
				),
			),
		);

		expect(chat.entries.map((message) => message.ordinal)).toEqual(
			Array.from({ length: ACTIVE_TRANSCRIPT_RETENTION_LIMIT + 50 }, (_, index) => index + 1),
		);
		expect(chat.lastOrdinal).toBe(ACTIVE_TRANSCRIPT_RETENTION_LIMIT + 50);
		expect(chat.loadedThroughOrdinal).toBe(ACTIVE_TRANSCRIPT_RETENTION_LIMIT + 50);
		expect(chat.hasEarlierMessages).toBe(false);
		expect(chat.hasLaterMessages).toBe(false);
	});

	it.each([
		{
			name: 'descending ordinals',
			messages: [entry(50, assistant('message-50')), entry(49, assistant('message-49'))],
			pageOldestOrdinal: 49,
			pageNewestOrdinal: 50,
		},
		{
			name: 'duplicate ordinals',
			messages: [
				entry(49, assistant('message-49')),
				entry(49, assistant('duplicate-49')),
				entry(50, assistant('message-50')),
			],
			pageOldestOrdinal: 49,
			pageNewestOrdinal: 50,
		},
		{
			name: 'overlap with the loaded interval',
			messages: [entry(50, assistant('message-50')), entry(51, assistant('overlap-51'))],
			pageOldestOrdinal: 50,
			pageNewestOrdinal: 51,
		},
	])('rejects an earlier page with $name before mutating the window', async ({
		messages,
		pageOldestOrdinal,
		pageNewestOrdinal,
	}) => {
		const chat = new ActiveTranscriptState();
		chat.replaceGeneration(
			'chat-1',
			'generation-1',
			Array.from({ length: 50 }, (_, index) =>
				entry(index + 51, assistant(`message-${index + 51}`)),
			),
			{ lastOrdinal: 100, pageOldestOrdinal: 51, hasMore: true },
		);
		vi.mocked(getChatMessages).mockResolvedValueOnce({
			chatId: 'chat-1',
			limit: 50,
			...page({
				messages,
				lastOrdinal: 100,
				pageOldestOrdinal,
				pageNewestOrdinal,
				hasMore: false,
			}),
		});
		vi.spyOn(console, 'error').mockImplementation(() => {});
		const entriesBeforePage = chat.entries;
		const revisionBeforePage = chat.feedMutationClock.dataRevision;

		await expect(chat.loadEarlierPage('chat-1')).resolves.toBe('failed');
		expect(chat.entries).toBe(entriesBeforePage);
		expect(chat.entries.map((message) => message.ordinal)).toEqual(
			Array.from({ length: 50 }, (_, index) => index + 51),
		);
		expect(chat.feedMutationClock.dataRevision).toBe(revisionBeforePage);
		expect(chat.pageStates.earlier.status).toBe('error');
	});

	it('grows one loaded interval across repeated bidirectional paging', async () => {
		const chat = new ActiveTranscriptState();
		const total = 400;
		chat.replaceGeneration(
			'chat-1',
			'generation-1',
			Array.from({ length: 50 }, (_, index) =>
				entry(index + 151, assistant(`message-${index + 151}`)),
			),
			{ lastOrdinal: total, pageOldestOrdinal: 151, pageNewestOrdinal: 200, hasMore: true },
		);
		chat.hasLaterMessages = true;
		vi.mocked(getChatMessages).mockImplementation(async (request) => {
			const limit = request.limit ?? 50;
			const end = Math.min(total, (request.beforeOrdinal ?? total + 1) - 1);
			const start = Math.max(1, end - limit + 1);
			const messages = Array.from({ length: end - start + 1 }, (_, index) =>
				entry(start + index, assistant(`message-${start + index}`)),
			);
			return {
				chatId: 'chat-1',
				limit,
				...page({
					messages,
					lastOrdinal: total,
					pageOldestOrdinal: start,
					hasMore: start > 1,
				}),
			};
		});

		for (let pageIndex = 0; pageIndex < 3; pageIndex += 1) {
			await expect(chat.loadEarlierPage('chat-1')).resolves.toBe('loaded');
		}
		expect(chat.entries[0]?.ordinal).toBe(1);
		expect(chat.entries.at(-1)?.ordinal).toBe(200);
		expect(chat.hasEarlierMessages).toBe(false);
		expect(chat.hasLaterMessages).toBe(true);

		for (let pageIndex = 0; pageIndex < 4; pageIndex += 1) {
			await expect(chat.loadLaterPage('chat-1')).resolves.toBe('loaded');
		}
		expect(chat.entries.map((message) => message.ordinal)).toEqual(
			Array.from({ length: total }, (_, index) => index + 1),
		);
		expect(chat.entries[0]?.ordinal).toBe(1);
		expect(chat.entries.at(-1)?.ordinal).toBe(total);
		expect(chat.hasEarlierMessages).toBe(false);
		expect(chat.hasLaterMessages).toBe(false);
		expect(chat.visibleMessageCount).toBe(total);
	});

	it('keeps the loaded later edge when earlier paging expands a detached window', async () => {
		const chat = new ActiveTranscriptState();
		chat.replaceGeneration(
			'chat-1',
			'generation-1',
			Array.from({ length: ACTIVE_TRANSCRIPT_RETENTION_LIMIT }, (_, index) =>
				entry(index + 201, assistant(`message-${index + 201}`)),
			),
			{ lastOrdinal: 400, pageOldestOrdinal: 201, hasMore: true },
		);
		chat.isUserScrolledUp = true;
		vi.mocked(getChatMessages).mockResolvedValueOnce({
			chatId: 'chat-1',
			limit: 50,
			...page({
				messages: Array.from({ length: 50 }, (_, index) =>
					entry(index + 151, assistant(`message-${index + 151}`)),
				),
				lastOrdinal: 400,
				pageOldestOrdinal: 151,
				pageNewestOrdinal: 200,
				hasMore: true,
			}),
		});

		await expect(chat.loadEarlierPage('chat-1')).resolves.toBe('loaded');

		expect(chat.entries.map((message) => message.ordinal)).toEqual(
			Array.from({ length: 250 }, (_, index) => index + 151),
		);
		expect(chat.loadedThroughOrdinal).toBe(400);
		expect(chat.hasLaterMessages).toBe(false);
	});

	it('fails an earlier page that claims more history without advancing', async () => {
		const chat = new ActiveTranscriptState();
		chat.replaceGeneration('chat-1', 'generation-1', [entry(51, assistant('message-51'))], {
			lastOrdinal: 100,
			pageOldestOrdinal: 51,
			hasMore: true,
		});
		vi.mocked(getChatMessages).mockResolvedValueOnce({
			chatId: 'chat-1',
			limit: 50,
			...page({
				messages: [entry(51, assistant('duplicate-51'))],
				lastOrdinal: 100,
				pageOldestOrdinal: 51,
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
			lastOrdinal: 100,
			pageOldestOrdinal: 51,
			hasMore: true,
		});
		vi.mocked(getChatMessages).mockResolvedValueOnce({
			chatId: 'chat-1',
			limit: 50,
			...page({ messages: [], lastOrdinal: 100, pageOldestOrdinal: 0, hasMore: true }),
		});
		vi.spyOn(console, 'error').mockImplementation(() => {});

		await expect(chat.loadEarlierPage('chat-1')).resolves.toBe('failed');
		expect(chat.pageStates.earlier).toMatchObject({
			status: 'error',
			error: 'Earlier transcript page did not advance the loaded window',
		});
		expect(chat.hasEarlierMessages).toBe(true);
	});

	it('retains an earlier failure while its explicit retry is loading', async () => {
		const chat = new ActiveTranscriptState();
		chat.replaceGeneration('chat-1', 'generation-1', [entry(51, assistant('message-51'))], {
			lastOrdinal: 100,
			pageOldestOrdinal: 51,
			hasMore: true,
		});
		vi.mocked(getChatMessages).mockRejectedValueOnce(new Error('network unavailable'));
		vi.spyOn(console, 'error').mockImplementation(() => {});

		await expect(chat.loadEarlierPage('chat-1')).resolves.toBe('failed');
		let resolveRetry!: (value: Awaited<ReturnType<typeof getChatMessages>>) => void;
		vi.mocked(getChatMessages).mockReturnValueOnce(
			new Promise((resolve) => {
				resolveRetry = resolve;
			}),
		);
		const retry = chat.loadEarlierPage('chat-1');

		expect(chat.pageStates.earlier).toEqual({
			status: 'loading',
			error: 'network unavailable',
		});
		resolveRetry({
			chatId: 'chat-1',
			limit: 50,
			...page({
				messages: [entry(50, assistant('message-50'))],
				lastOrdinal: 100,
				pageOldestOrdinal: 50,
				hasMore: false,
			}),
		});
		await expect(retry).resolves.toBe('loaded');
		expect(chat.pageStates.earlier).toEqual({ status: 'idle', error: null });
	});

	it('invalidates an earlier page when gap recovery replaces the loaded window', async () => {
		const chat = new ActiveTranscriptState();
		chat.replaceGeneration(
			'chat-1',
			'generation-1',
			Array.from({ length: 50 }, (_, index) =>
				entry(index + 51, assistant(`message-${index + 51}`)),
			),
			{ lastOrdinal: 100, pageOldestOrdinal: 51, hasMore: true },
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
		chat.oldestOrdinal = 1;
		chat.lastOrdinal = 50;
		expect(applyMessages(chat, 'chat-1', 'generation-1', [entry(101, assistant('live'))])).toBe(
			'applied',
		);
		resolveEarlier({
			chatId: 'chat-1',
			limit: 50,
			...page({
				messages: Array.from({ length: 50 }, (_, index) =>
					entry(index + 1, assistant(`earlier-${index + 1}`)),
				),
				lastOrdinal: 101,
				pageOldestOrdinal: 1,
				hasMore: false,
			}),
		});

		await expect(earlierLoad).resolves.toBe('invalidated');
		expect(chat.entries.map((message) => message.ordinal)).toEqual(
			Array.from({ length: 51 }, (_, index) => index + 51),
		);
	});

	it('signals generation changes without replacing the current generation', () => {
		const chat = new ActiveTranscriptState();
		applyMessages(chat, 'chat-1', 'generation-1', [entry(1, user('old'))]);

		const result = applyMessages(chat, 'chat-1', 'generation-2', [entry(1, assistant('fresh'))]);

		expect(result).toBe('view-changed');
		expect(chat.chatMessages.map(contentOf)).toEqual(['old']);
		expect(chat.getCursor()).toEqual({ transcriptViewId: 'generation-1', lastOrdinal: 1 });
	});

	it.each([
		{
			name: 'another transcript view',
			transcriptViewId: 'generation-2',
			ordinal: 1,
			expectedResult: 'view-changed' as const,
		},
		{
			name: 'a noncontiguous ordinal range',
			transcriptViewId: 'generation-1',
			ordinal: 3,
			expectedResult: 'gap-detected' as const,
		},
	])(
		'does not acknowledge an optimistic input from $name',
		({ transcriptViewId, ordinal, expectedResult }) => {
			const chat = new ActiveTranscriptState();
			applyMessages(chat, 'chat-1', 'generation-1', [entry(1, assistant('current'))]);
			chat.upsertOptimisticUserInput(optimisticInput());

			const result = applyMessages(chat, 'chat-1', transcriptViewId, [
				entry(ordinal, user('rejected echo', { clientMessageId: 'msg-1' })),
			]);

			expect(result).toBe(expectedResult);
			expect(chat.optimisticUserInputs).toEqual([optimisticInput()]);
			expect(chat.displayMessages.map(contentOf)).toEqual(['current', 'optimistic']);
		},
	);

	it('places a new optimistic input after the durable tail despite timestamp skew', () => {
		const chat = new ActiveTranscriptState();
		applyMessages(chat, 'chat-1', 'generation-1', [
			entry(1, new AssistantMessage('2099-01-01T00:00:00.000Z', 'durable tail')),
		]);

		chat.upsertOptimisticUserInput(optimisticInput({
			createdAt: '2000-01-01T00:00:00.000Z',
		}));

		expect(chat.displayMessages.map(contentOf)).toEqual(['durable tail', 'optimistic']);
		expect(chat.visibleRows.map((row) => row.id)).toEqual([
			'generation-1:1',
			'optimistic:msg-1',
		]);
	});

	it('preserves optimistic submission order despite timestamp skew', () => {
		const chat = new ActiveTranscriptState();
		chat.upsertOptimisticUserInput(optimisticInput({
			clientMessageId: 'msg-first',
			content: 'first submitted',
			createdAt: '2099-01-01T00:00:00.000Z',
		}));
		chat.upsertOptimisticUserInput(optimisticInput({
			clientMessageId: 'msg-second',
			content: 'second submitted',
			createdAt: '2000-01-01T00:00:00.000Z',
		}));

		expect(chat.displayMessages.map(contentOf)).toEqual([
			'first submitted',
			'second submitted',
		]);
		expect(chat.visibleRows.map((row) => row.id)).toEqual([
			'optimistic:msg-first',
			'optimistic:msg-second',
		]);
	});

	it('places durable rows between the optimistic submissions they separate', () => {
		const chat = new ActiveTranscriptState();
		applyMessages(chat, 'chat-1', 'generation-1', [
			entry(1, new AssistantMessage('2099-01-01T00:00:00.000Z', 'durable first')),
		]);
		chat.upsertOptimisticUserInput(optimisticInput({
			clientMessageId: 'msg-first',
			content: 'first submitted',
			createdAt: '2000-01-01T00:00:00.000Z',
		}));

		applyMessages(chat, 'chat-1', 'generation-1', [
			entry(2, new AssistantMessage('1990-01-01T00:00:00.000Z', 'durable between')),
		]);
		chat.upsertOptimisticUserInput(optimisticInput({
			clientMessageId: 'msg-second',
			content: 'second submitted',
			createdAt: '1980-01-01T00:00:00.000Z',
		}));

		expect(chat.displayMessages.map(contentOf)).toEqual([
			'durable first',
			'first submitted',
			'durable between',
			'second submitted',
		]);
		expect(chat.visibleRows.map((row) => row.id)).toEqual([
			'generation-1:1',
			'optimistic:msg-first',
			'generation-1:2',
			'optimistic:msg-second',
		]);
	});

	it('updates an optimistic retry without changing its submission position', () => {
		const chat = new ActiveTranscriptState();
		chat.upsertOptimisticUserInput(optimisticInput({
			clientMessageId: 'msg-first',
			content: 'first submitted',
		}));
		chat.upsertOptimisticUserInput(optimisticInput({
			clientMessageId: 'msg-second',
			content: 'second submitted',
		}));

		chat.upsertOptimisticUserInput(optimisticInput({
			clientMessageId: 'msg-first',
			content: 'first retry',
			createdAt: '2099-01-01T00:00:00.000Z',
			delivery: 'delivered',
		}));

		expect(chat.displayMessages.map(contentOf)).toEqual([
			'first retry',
			'second submitted',
		]);
		expect(chat.visibleRows.map((row) => row.id)).toEqual([
			'optimistic:msg-first',
			'optimistic:msg-second',
		]);
	});

	it('keeps a later optimistic submission after an earlier durable echo', () => {
		const chat = new ActiveTranscriptState();
		applyMessages(chat, 'chat-1', 'generation-1', [entry(1, assistant('durable tail'))]);
		chat.upsertOptimisticUserInput(optimisticInput({
			clientMessageId: 'msg-first',
			content: 'first submitted',
		}));
		chat.upsertOptimisticUserInput(optimisticInput({
			clientMessageId: 'msg-second',
			content: 'second submitted',
		}));

		applyMessages(chat, 'chat-1', 'generation-1', [
			entry(2, user('first submitted', { clientMessageId: 'msg-first' })),
		]);

		expect(chat.displayMessages.map(contentOf)).toEqual([
			'durable tail',
			'first submitted',
			'second submitted',
		]);
		expect(chat.visibleRows.map((row) => row.id)).toEqual([
			'generation-1:1',
			'generation-1:2',
			'optimistic:msg-second',
		]);
	});

	it('preserves optimistic gaps while durable echoes and provider rows interleave', () => {
		const chat = new ActiveTranscriptState();
		applyMessages(chat, 'chat-1', 'generation-1', [entry(1, assistant('durable tail'))]);
		for (const [clientMessageId, content] of [
			['msg-a', 'submitted a'],
			['msg-b', 'submitted b'],
			['msg-c', 'submitted c'],
			['msg-d', 'submitted d'],
		] as const) {
			chat.upsertOptimisticUserInput(optimisticInput({ clientMessageId, content }));
		}

		applyMessages(chat, 'chat-1', 'generation-1', [
			entry(2, user('submitted a', { clientMessageId: 'msg-a' })),
			entry(3, user('submitted c', { clientMessageId: 'msg-c' })),
			entry(4, assistant('provider output')),
		]);

		expect(chat.displayMessages.map(contentOf)).toEqual([
			'durable tail',
			'submitted a',
			'submitted b',
			'submitted c',
			'submitted d',
			'provider output',
		]);
		expect(chat.visibleRows.map((row) => row.id)).toEqual([
			'generation-1:1',
			'generation-1:2',
			'optimistic:msg-b',
			'generation-1:3',
			'optimistic:msg-d',
			'generation-1:4',
		]);

		applyMessages(chat, 'chat-1', 'generation-1', [
			entry(5, user('submitted b', { clientMessageId: 'msg-b' })),
		]);

		expect(chat.displayMessages.map(contentOf)).toEqual([
			'durable tail',
			'submitted a',
			'submitted c',
			'provider output',
			'submitted b',
			'submitted d',
		]);
		expect(chat.visibleRows.map((row) => row.id)).toEqual([
			'generation-1:1',
			'generation-1:2',
			'generation-1:3',
			'generation-1:4',
			'generation-1:5',
			'optimistic:msg-d',
		]);
	});

	it('renders local messages as transient display-only rows', () => {
		const chat = new ActiveTranscriptState();
		applyMessages(chat, 'chat-1', 'generation-1', [entry(1, user('server'))]);

		chat.appendLocalNotice('progress', 'local status');
		chat.appendLocalNotice('error', 'local error');

		expect(chat.chatMessages.map(contentOf)).toEqual(['server']);
		expect(chat.visibleRows.map(rowContentOf)).toEqual(['server', 'local status', 'local error']);
		expect(chat.visibleRows.at(-2)).toMatchObject({ kind: 'local-notice', noticeType: 'progress' });
		expect(chat.visibleRows.at(-1)).toMatchObject({ kind: 'local-notice', noticeType: 'error' });
	});

	it('clears transient local messages when new server messages apply', () => {
		const chat = new ActiveTranscriptState();
		applyMessages(chat, 'chat-1', 'generation-1', [entry(1, user('server'))]);
		chat.appendLocalNotice('progress', 'local status');
		chat.appendLocalNotice('error', 'local error');

		applyMessages(chat, 'chat-1', 'generation-1', [entry(2, assistant('next'))]);

		expect(chat.visibleRows.map(rowContentOf)).toEqual(['server', 'next']);
	});

	it('clears transient local messages when an optimistic user input is submitted', () => {
		const chat = new ActiveTranscriptState();
		applyMessages(chat, 'chat-1', 'generation-1', [entry(1, user('server'))]);
		chat.appendLocalNotice('warning', 'Chat interrupted by user.');
		const noticeBottomRowId = chat.visibleRows.at(-1)?.id;
		expect(chat.displayMessageCount).toBe(2);
		expect(noticeBottomRowId).toMatch(/^local_/);

		chat.upsertOptimisticUserInput({
			chatId: 'chat-1',
			clientMessageId: 'msg-1',
			content: 'continue',
			createdAt: '2026-06-01T00:00:01.000Z',
			delivery: 'pending',
		});

		expect(chat.visibleRows.map(rowContentOf)).toEqual(['server', 'continue']);
		expect(chat.displayMessageCount).toBe(2);
		expect(chat.visibleRows.at(-1)?.id).toBe('optimistic:msg-1');
		expect(chat.visibleRows.at(-1)?.id).not.toBe(noticeBottomRowId);
	});

	it('marks an optimistic row awaiting delivery until the request comes back', () => {
		const chat = new ActiveTranscriptState();
		applyMessages(chat, 'chat-1', 'generation-1', [entry(1, user('server'))]);
		chat.upsertOptimisticUserInput(optimisticInput());

		const pendingRow = () => chat.visibleRows.find((row) => row.id === 'optimistic:msg-1');
		expect(pendingRow()).toMatchObject({ awaitingDelivery: true });

		chat.markOptimisticUserInputDelivered('msg-1');

		expect(pendingRow()).not.toHaveProperty('awaitingDelivery');
	});

	it('keeps transient local messages when replay only overlaps existing server messages', () => {
		const chat = new ActiveTranscriptState();
		applyMessages(chat, 'chat-1', 'generation-1', [entry(1, user('server'))]);
		chat.appendLocalNotice('error', 'local error');

		applyMessages(chat, 'chat-1', 'generation-1', [entry(1, user('duplicate'))]);

		expect(chat.visibleRows.map(rowContentOf)).toEqual(['server', 'local error']);
	});

	it('detects same-generation gaps without advancing the cursor', () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const chat = new ActiveTranscriptState();
		applyMessages(chat, 'chat-1', 'generation-1', [entry(1, user('server'))]);

		const result = applyMessages(chat, 'chat-1', 'generation-1', [entry(3, assistant('later'))]);

		expect(result).toBe('gap-detected');
		expect(chat.chatMessages.map(contentOf)).toEqual(['server']);
		expect(chat.getCursor()).toEqual({ transcriptViewId: 'generation-1', lastOrdinal: 1 });
		expect(warn).toHaveBeenCalledWith(expect.stringContaining('expected=2 received=3'));
		warn.mockRestore();
	});

	it('keeps the current transcript visible while a changed generation reloads', () => {
		const chat = new ActiveTranscriptState();
		applyMessages(chat, 'chat-1', 'generation-1', [entry(1, user('old'))]);
		chat.appendLocalNotice('error', 'local error');

		const result = applyMessages(chat, 'chat-1', 'generation-2', [entry(1, assistant('fresh'))]);

		expect(result).toBe('view-changed');
		expect(chat.visibleRows.map(rowContentOf)).toEqual(['old', 'local error']);
		expect(chat.getCursor()).toEqual({ transcriptViewId: 'generation-1', lastOrdinal: 1 });
	});

	it('renders repeated durable user rows as distinct transcript occurrences', () => {
		const chat = new ActiveTranscriptState();

		applyMessages(chat, 'chat-1', 'generation-1', [
			entry(1, user('once', { clientRequestId: 'req-1' })),
			entry(2, user('once', { clientRequestId: 'req-1' })),
		]);

		expect(chat.displayMessages.map(contentOf)).toEqual(['once', 'once']);
		expect(chat.getCursor()).toEqual({ transcriptViewId: 'generation-1', lastOrdinal: 2 });
	});

	it('exposes canonical durable and optimistic display row identities', () => {
		const chat = new ActiveTranscriptState();
		chat.replaceGeneration('chat-1', 'generation-1', [entry(1, user('durable'))], {
			lastOrdinal: 1,
			pageOldestOrdinal: 1,
			hasMore: false,
		});
		chat.upsertOptimisticUserInput({
			chatId: 'chat-1',
			clientMessageId: 'message-1',
			content: 'optimistic',
			createdAt: '2026-06-01T00:00:01.000Z',
			delivery: 'pending',
		});

		expect(chat.displayRows).toMatchObject([
			{ kind: 'message', id: 'generation-1:1', ordinal: 1 },
			{ kind: 'message', id: 'optimistic:message-1' },
		]);
	});

	it('buffers live same-generation messages while a snapshot is loading', () => {
		const chat = new ActiveTranscriptState();
		const epoch = chat.beginSnapshotLoad();

		applyMessages(chat, 'chat-1', 'generation-1', [entry(2, assistant('live'))]);
		const result = chat.setFromPage(
			'chat-1',
			page({
				transcriptViewId: 'generation-1',
				messages: [entry(1, user('history'))],
				lastOrdinal: 1,
			}),
			epoch,
		);

		expect(result).toBe('applied');
		expect(chat.chatMessages.map(contentOf)).toEqual(['history', 'live']);
		expect(chat.getCursor()).toEqual({ transcriptViewId: 'generation-1', lastOrdinal: 2 });
	});

	it('preserves notices created after buffered live messages across successful snapshots', () => {
		const chat = new ActiveTranscriptState();
		chat.replaceGeneration('chat-1', 'generation-1', [entry(1, assistant('existing'))], {
			lastOrdinal: 1,
			pageOldestOrdinal: 1,
			hasMore: false,
		});
		chat.appendLocalNotice('warning', 'stale notice');
		const epoch = chat.beginSnapshotLoad();

		applyMessages(chat, 'chat-1', 'generation-1', [entry(2, assistant('live'))]);
		chat.appendLocalNotice('error', 'newer notice');
		const result = chat.setFromPage(
			'chat-1',
			page({ messages: [entry(1, assistant('existing'))], lastOrdinal: 1 }),
			epoch,
		);

		expect(result).toBe('applied');
		expect(chat.chatMessages.map(contentOf)).toEqual(['existing', 'live']);
		expect(chat.visibleRows.map(rowContentOf)).toEqual(['existing', 'live', 'newer notice']);
	});

	it('applies buffered live messages when a snapshot load fails', async () => {
		const chat = new ActiveTranscriptState();
		chat.replaceGeneration('chat-1', 'generation-1', [entry(1, assistant('existing'))], {
			lastOrdinal: 1,
			pageOldestOrdinal: 1,
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
		expect(applyMessages(chat, 'chat-1', 'generation-1', [entry(2, assistant('live'))])).toBe(
			'applied',
		);
		chat.appendLocalNotice('error', 'newer notice');
		rejectSnapshot(new Error('snapshot unavailable'));

		await expect(snapshotLoad).rejects.toThrow('snapshot unavailable');
		expect(chat.chatMessages.map(contentOf)).toEqual(['existing', 'live']);
		expect(chat.visibleRows.map(rowContentOf)).toEqual(['existing', 'live', 'newer notice']);
		expect(chat.getCursor()).toEqual({ transcriptViewId: 'generation-1', lastOrdinal: 2 });
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
			lastOrdinal: 1,
			pageOldestOrdinal: 1,
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
		applyMessages(chat, 'chat-1', 'generation-1', [entry(2, assistant('live'))]);
		const secondLoad = chat.loadMessages('chat-1');
		resolveSecondSnapshot({
			chatId: 'chat-1',
			limit: 50,
			...page({ messages: [entry(1, assistant('existing'))], lastOrdinal: 1 }),
		});

		await expect(secondLoad).resolves.toEqual([
			expect.objectContaining({ content: 'existing' }),
			expect.objectContaining({ content: 'live' }),
		]);
		resolveFirstSnapshot({
			chatId: 'chat-1',
			limit: 50,
			...page({ messages: [entry(1, assistant('existing'))], lastOrdinal: 1 }),
		});
		await expect(firstLoad).resolves.toEqual([
			expect.objectContaining({ content: 'existing' }),
			expect.objectContaining({ content: 'live' }),
		]);
		expect(chat.getCursor()).toEqual({ transcriptViewId: 'generation-1', lastOrdinal: 2 });
	});

	it('preserves notices created after a superseding snapshot starts', async () => {
		const chat = new ActiveTranscriptState();
		chat.replaceGeneration('chat-1', 'generation-1', [entry(1, assistant('existing'))], {
			lastOrdinal: 1,
			pageOldestOrdinal: 1,
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
			...page({ messages: [entry(1, assistant('existing'))], lastOrdinal: 1 }),
		});
		await firstLoad;
		chat.appendLocalNotice('error', 'newer notice');
		resolveSecondSnapshot({
			chatId: 'chat-1',
			limit: 50,
			...page({ messages: [entry(1, assistant('existing'))], lastOrdinal: 1 }),
		});

		await secondLoad;
		expect(chat.visibleRows.map(rowContentOf)).toEqual(['existing', 'newer notice']);
	});

	it('clears loading state when switching away from an active snapshot load', async () => {
		const chat = new ActiveTranscriptState();
		chat.replaceGeneration('chat-1', 'generation-1', [entry(1, assistant('existing'))], {
			lastOrdinal: 1,
			pageOldestOrdinal: 1,
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
			...page({ messages: [entry(1, assistant('existing'))], lastOrdinal: 1 }),
		});

		await snapshotLoad;
		expect(chat.activeChatId).toBe('chat-draft');
		expect(chat.loadStatus).toBe('idle');
		expect(chat.isLoadingMessages).toBe(false);
	});

	it('does not let a stale snapshot failure overwrite the active chat load state', async () => {
		const chat = new ActiveTranscriptState();
		chat.replaceGeneration('chat-1', 'generation-1', [entry(1, assistant('one'))], {
			lastOrdinal: 1,
			pageOldestOrdinal: 1,
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
					transcriptViewId: 'generation-2',
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

		applyMessages(chat, 'chat-1', 'generation-1', [entry(5, assistant('later'))]);
		const result = chat.setFromPage(
			'chat-1',
			page({
				transcriptViewId: 'generation-1',
				messages: [entry(1, user('one')), entry(2, assistant('two')), entry(3, assistant('three'))],
				lastOrdinal: 3,
			}),
			epoch,
		);

		expect(result).toBe('gap-detected');
		expect(chat.chatMessages.map(contentOf)).toEqual(['one', 'two', 'three']);
		expect(chat.getCursor()).toEqual({ transcriptViewId: 'generation-1', lastOrdinal: 3 });
		warn.mockRestore();
	});

	it('does not install a stale snapshot when buffered messages indicate a new generation', () => {
		const chat = new ActiveTranscriptState();
		chat.replaceGeneration('chat-1', 'current-generation', [entry(1, assistant('current'))], {
			lastOrdinal: 1,
			pageOldestOrdinal: 1,
			hasMore: false,
		});
		const epoch = chat.beginSnapshotLoad();

		applyMessages(chat, 'chat-1', 'new-generation', [entry(1, assistant('new live'))]);
		const result = chat.setFromPage(
			'chat-1',
			page({
				transcriptViewId: 'old-generation',
				messages: [entry(1, user('old page'))],
				lastOrdinal: 1,
			}),
			epoch,
		);

		expect(result).toBe('view-changed');
		expect(chat.chatMessages.map(contentOf)).toEqual(['current']);
		expect(chat.getCursor()).toEqual({ transcriptViewId: 'current-generation', lastOrdinal: 1 });
	});

	it.each(['initial', 'latest'] as const)(
		'preserves snapshot reload ownership when %s navigation races a generation change',
		async (target) => {
			const chat = new ActiveTranscriptState();
			chat.replaceGeneration('chat-1', 'generation-1', [entry(1, assistant('current'))], {
				lastOrdinal: 1,
				pageOldestOrdinal: 1,
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
			expect(applyMessages(chat, 'chat-1', 'generation-2', [entry(1, assistant('new live'))])).toBe(
				'applied',
			);

			await expect(chat.navigateToWindow('chat-1', target)).resolves.toBe('invalidated');
			expect(getChatMessages).toHaveBeenCalledOnce();

			resolveOldSnapshot({
				chatId: 'chat-1',
				limit: 50,
				...page({
					transcriptViewId: 'generation-1',
					messages: [entry(1, assistant('old snapshot'))],
					lastOrdinal: 1,
				}),
			});
			await vi.waitFor(() => expect(getChatMessages).toHaveBeenCalledTimes(2));
			resolveNewSnapshot({
				chatId: 'chat-1',
				limit: 50,
				...page({
					transcriptViewId: 'generation-2',
					messages: [entry(1, assistant('new snapshot'))],
					lastOrdinal: 1,
				}),
			});

			await expect(snapshotLoad).resolves.toEqual([
				expect.objectContaining({ content: 'new snapshot' }),
			]);
			expect(chat.chatMessages.map(contentOf)).toEqual(['new snapshot']);
			expect(chat.getCursor()).toEqual({ transcriptViewId: 'generation-2', lastOrdinal: 1 });
		},
	);

	it('keeps an optimistic row until its durable client-message echo arrives', () => {
		const chat = new ActiveTranscriptState();
		chat.upsertOptimisticUserInput(optimisticInput());

		expect(chat.optimisticUserInputs).toEqual([optimisticInput()]);
		expect(chat.displayMessages.map(contentOf)).toEqual(['optimistic']);

		applyMessages(chat, 'chat-1', 'generation-1', [
			entry(1, user('durable', { clientMessageId: 'msg-1' })),
		]);

		expect(chat.optimisticUserInputs).toEqual([]);
		expect(chat.displayMessages.map(contentOf)).toEqual(['durable']);
	});

	it('applies buffered reconnect metadata with its exact live batch', () => {
		const chat = new ActiveTranscriptState();
		chat.replaceGeneration('chat-1', 'generation-1', [entry(1, assistant('initial'))], {
			lastOrdinal: 1,
			pageOldestOrdinal: 1,
			hasMore: false,
		});
		chat.appendLocalNotice('warning', 'notice before replay');
		const replayCandidate = { ordinal: 2, content: 'replay candidate', attachmentNames: [] };
		const liveCandidate = { ordinal: 3, content: 'live candidate', attachmentNames: ['live.txt'] };
		const token = chat.beginReconnectReplay('chat-1', 'generation-1');

		expect(
			chat.applyReconnectReplayPage(
				token,
				'chat-1',
				'generation-1',
				[entry(2, assistant('replayed'))],
				2,
				2,
				[replayCandidate],
			),
		).toBe('applied');
		chat.appendLocalNotice('warning', 'notice before live batch');
		expect(
			chat.applyMessages('chat-1', 'generation-1', [entry(3, assistant('live'))], 3, 3, [
				liveCandidate,
			]),
		).toBe('applied');
		chat.appendLocalNotice('error', 'notice after live batch');

		expect(chat.entries.map((message) => message.ordinal)).toEqual([1, 2]);
		expect(chat.resendCandidates).toEqual([replayCandidate]);
		expect(chat.localNotices.map((notice) => notice.content)).toEqual([
			'notice before live batch',
			'notice after live batch',
		]);

		expect(chat.finishReconnectReplay(token, 'chat-1')).toBe('applied');
		expect(
			chat.entries.map((message) => ({
				ordinal: message.ordinal,
				content: contentOf(message.message),
			})),
		).toEqual([
			{ ordinal: 1, content: 'initial' },
			{ ordinal: 2, content: 'replayed' },
			{ ordinal: 3, content: 'live' },
		]);
		expect(chat.resendCandidates).toEqual([liveCandidate]);
		expect(chat.localNotices.map((notice) => notice.content)).toEqual(['notice after live batch']);
	});

	it('preserves an expanded detached interval through reconnect replay and buffered live rows', async () => {
		const chat = new ActiveTranscriptState();
		chat.replaceGeneration('chat-1', 'generation-1', assistantEntries(201, 400), {
			lastOrdinal: 400,
			pageOldestOrdinal: 201,
			hasMore: true,
		});
		chat.isUserScrolledUp = true;
		vi.mocked(getChatMessages).mockResolvedValueOnce({
			chatId: 'chat-1',
			limit: 50,
			...page({
				messages: assistantEntries(151, 200, (ordinal) =>
					ordinal === 175 ? 'equal-content' : `message-${ordinal}`,
				),
				lastOrdinal: 400,
				pageOldestOrdinal: 151,
				pageNewestOrdinal: 200,
				hasMore: true,
			}),
		});
		await expect(chat.loadEarlierPage('chat-1')).resolves.toBe('loaded');
		chat.revealAllLoadedMessages();

		const replayToken = chat.beginReconnectReplay('chat-1', 'generation-1');
		expect(chat.applyReconnectReplayPage(
			replayToken,
			'chat-1',
			'generation-1',
			assistantEntries(401, 425, (ordinal) =>
				ordinal === 425 ? 'equal-content' : `message-${ordinal}`,
			),
			401,
			425,
			[],
		)).toBe('applied');
		expect(applyMessages(
			chat,
			'chat-1',
			'generation-1',
			assistantEntries(426, 427),
		)).toBe('applied');

		expect(chat.finishReconnectReplay(replayToken, 'chat-1')).toBe('applied');
		expect(chat.entries.map((message) => message.ordinal)).toEqual(
			Array.from({ length: 277 }, (_, index) => index + 151),
		);
		expect(chat.entries.filter((message) => contentOf(message.message) === 'equal-content'))
			.toEqual([
				expect.objectContaining({ ordinal: 175 }),
				expect.objectContaining({ ordinal: 425 }),
			]);
		expect(chat.visibleRows).toHaveLength(277);
		expect(chat.visibleRows[0]).toMatchObject({ id: 'generation-1:151', ordinal: 151 });
		expect(chat.visibleRows.at(-1)).toMatchObject({ id: 'generation-1:427', ordinal: 427 });
		expect(chat.getCursor()).toEqual({ transcriptViewId: 'generation-1', lastOrdinal: 427 });
	});

	it('preserves an expanded detached prefix when a same-view snapshot overlaps it', async () => {
		const chat = new ActiveTranscriptState();
		chat.replaceGeneration('chat-1', 'generation-1', assistantEntries(201, 400), {
			lastOrdinal: 400,
			pageOldestOrdinal: 201,
			hasMore: true,
		});
		chat.isUserScrolledUp = true;
		vi.mocked(getChatMessages).mockResolvedValueOnce({
			chatId: 'chat-1',
			limit: 50,
			...page({
				messages: assistantEntries(151, 200),
				lastOrdinal: 400,
				pageOldestOrdinal: 151,
				pageNewestOrdinal: 200,
				hasMore: true,
			}),
		});
		await expect(chat.loadEarlierPage('chat-1')).resolves.toBe('loaded');
		chat.revealAllLoadedMessages();

		const snapshotEpoch = chat.beginSnapshotLoad();
		expect(chat.setFromPage(
			'chat-1',
			page({
				transcriptViewId: 'generation-1',
				messages: assistantEntries(301, 500),
				lastOrdinal: 500,
				pageOldestOrdinal: 301,
				pageNewestOrdinal: 500,
				hasMore: true,
			}),
			snapshotEpoch,
		)).toBe('applied');

		expect(chat.entries.map((message) => message.ordinal)).toEqual(
			Array.from({ length: 350 }, (_, index) => index + 151),
		);
		expect(chat.visibleRows).toHaveLength(350);
		expect(chat.visibleRows[0]).toMatchObject({ id: 'generation-1:151', ordinal: 151 });
		expect(chat.visibleRows.at(-1)).toMatchObject({ id: 'generation-1:500', ordinal: 500 });
		expect(chat.getCursor()).toEqual({ transcriptViewId: 'generation-1', lastOrdinal: 500 });
	});

	it.each([
		{
			name: 'contained',
			current: [101, 200] as const,
			snapshot: [151, 200] as const,
			expected: [101, 200] as const,
			expectedLoadedThrough: 200,
			hasLaterMessages: false,
		},
		{
			name: 'earlier-extending',
			current: [201, 300] as const,
			snapshot: [101, 300] as const,
			expected: [101, 300] as const,
			expectedLoadedThrough: 300,
			hasLaterMessages: false,
		},
		{
			name: 'later-overlapping',
			current: [101, 300] as const,
			snapshot: [251, 350] as const,
			expected: [101, 350] as const,
			expectedLoadedThrough: 350,
			hasLaterMessages: false,
		},
		{
			name: 'later-touching',
			current: [101, 200] as const,
			snapshot: [201, 250] as const,
			expected: [101, 250] as const,
			expectedLoadedThrough: 250,
			hasLaterMessages: false,
		},
		{
			name: 'later-disjoint',
			current: [101, 200] as const,
			snapshot: [251, 300] as const,
			expected: [101, 200] as const,
			expectedLoadedThrough: 200,
			hasLaterMessages: true,
		},
	])(
		'preserves immutable ordinal occurrences across a $name same-view snapshot',
		({ current, snapshot, expected, expectedLoadedThrough, hasLaterMessages }) => {
			const chat = new ActiveTranscriptState();
			chat.replaceGeneration(
				'chat-1',
				'generation-1',
				assistantEntries(current[0], current[1], (ordinal) => `current-${ordinal}`),
				{
					lastOrdinal: current[1],
					pageOldestOrdinal: current[0],
					hasMore: current[0] > 1,
				},
			);

			const snapshotEpoch = chat.beginSnapshotLoad();
			expect(chat.setFromPage(
				'chat-1',
				page({
					transcriptViewId: 'generation-1',
					messages: assistantEntries(
						snapshot[0],
						snapshot[1],
						(ordinal) => `snapshot-${ordinal}`,
					),
					lastOrdinal: snapshot[1],
					pageOldestOrdinal: snapshot[0],
					pageNewestOrdinal: snapshot[1],
					hasMore: snapshot[0] > 1,
				}),
				snapshotEpoch,
			)).toBe('applied');

			const expectedOrdinals = Array.from(
				{ length: expected[1] - expected[0] + 1 },
				(_, index) => expected[0] + index,
			);
			expect(chat.entries.map((message) => message.ordinal)).toEqual(expectedOrdinals);
			expect(chat.entries.map((message) => contentOf(message.message))).toEqual(
				expectedOrdinals.map((ordinal) => (
					ordinal >= current[0] && ordinal <= current[1]
						? `current-${ordinal}`
						: `snapshot-${ordinal}`
				)),
			);
			expect(chat.loadedThroughOrdinal).toBe(expectedLoadedThrough);
			expect(chat.hasLaterMessages).toBe(hasLaterMessages);
		},
	);

	it('merges an expanded prefix, overlapping snapshot, and buffered live suffix by ordinal', async () => {
		const chat = new ActiveTranscriptState();
		chat.replaceGeneration('chat-1', 'generation-1', assistantEntries(201, 400), {
			lastOrdinal: 400,
			pageOldestOrdinal: 201,
			hasMore: true,
		});
		chat.isUserScrolledUp = true;
		vi.mocked(getChatMessages).mockResolvedValueOnce({
			chatId: 'chat-1',
			limit: 50,
			...page({
				messages: assistantEntries(151, 200, (ordinal) =>
					ordinal === 175 ? 'repeated-across-snapshot' : `message-${ordinal}`,
				),
				lastOrdinal: 400,
				pageOldestOrdinal: 151,
				pageNewestOrdinal: 200,
				hasMore: true,
			}),
		});
		await expect(chat.loadEarlierPage('chat-1')).resolves.toBe('loaded');
		chat.revealAllLoadedMessages();

		const snapshotEpoch = chat.beginSnapshotLoad();
		expect(applyMessages(
			chat,
			'chat-1',
			'generation-1',
			assistantEntries(501, 502, (ordinal) =>
				ordinal === 501 ? 'repeated-across-snapshot' : `message-${ordinal}`,
			),
		)).toBe('applied');
		expect(chat.setFromPage(
			'chat-1',
			page({
				transcriptViewId: 'generation-1',
				messages: assistantEntries(301, 500),
				lastOrdinal: 500,
				pageOldestOrdinal: 301,
				pageNewestOrdinal: 500,
				hasMore: true,
			}),
			snapshotEpoch,
		)).toBe('applied');

		expect(chat.entries.map((message) => message.ordinal)).toEqual(
			Array.from({ length: 352 }, (_, index) => index + 151),
		);
		expect(chat.entries.filter(
			(message) => contentOf(message.message) === 'repeated-across-snapshot',
		)).toEqual([
			expect.objectContaining({ ordinal: 175 }),
			expect.objectContaining({ ordinal: 501 }),
		]);
		expect(chat.visibleRows).toHaveLength(352);
		expect(chat.getCursor()).toEqual({ transcriptViewId: 'generation-1', lastOrdinal: 502 });
	});

	it('continues earlier paging from the retained prefix after a same-view snapshot', async () => {
		const chat = new ActiveTranscriptState();
		chat.replaceGeneration('chat-1', 'generation-1', assistantEntries(201, 400), {
			lastOrdinal: 400,
			pageOldestOrdinal: 201,
			hasMore: true,
		});
		chat.isUserScrolledUp = true;
		vi.mocked(getChatMessages)
			.mockResolvedValueOnce({
				chatId: 'chat-1',
				limit: 50,
				...page({
					messages: assistantEntries(151, 200, (ordinal) =>
						ordinal === 175 ? 'same-text-different-ordinal' : `message-${ordinal}`,
					),
					lastOrdinal: 400,
					pageOldestOrdinal: 151,
					pageNewestOrdinal: 200,
					hasMore: true,
				}),
			})
			.mockResolvedValueOnce({
				chatId: 'chat-1',
				limit: 50,
				...page({
					messages: assistantEntries(101, 150, (ordinal) =>
						ordinal === 125 ? 'same-text-different-ordinal' : `message-${ordinal}`,
					),
					lastOrdinal: 500,
					pageOldestOrdinal: 101,
					pageNewestOrdinal: 150,
					hasMore: true,
				}),
			});

		await expect(chat.loadEarlierPage('chat-1')).resolves.toBe('loaded');
		chat.revealAllLoadedMessages();
		const snapshotEpoch = chat.beginSnapshotLoad();
		expect(chat.setFromPage(
			'chat-1',
			page({
				transcriptViewId: 'generation-1',
				messages: assistantEntries(301, 500),
				lastOrdinal: 500,
				pageOldestOrdinal: 301,
				pageNewestOrdinal: 500,
				hasMore: true,
			}),
			snapshotEpoch,
		)).toBe('applied');
		expect(chat.oldestOrdinal).toBe(151);
		expect(chat.hasEarlierMessages).toBe(true);

		await expect(chat.loadEarlierPage('chat-1')).resolves.toBe('loaded');
		chat.revealAllLoadedMessages();
		expect(vi.mocked(getChatMessages)).toHaveBeenNthCalledWith(2, {
			chatId: 'chat-1',
			beforeOrdinal: 151,
			limit: 50,
			transcriptViewId: 'generation-1',
		});
		expect(chat.entries.map((message) => message.ordinal)).toEqual(
			Array.from({ length: 400 }, (_, index) => index + 101),
		);
		expect(chat.entries.filter(
			(message) => contentOf(message.message) === 'same-text-different-ordinal',
		)).toEqual([
			expect.objectContaining({ ordinal: 125 }),
			expect.objectContaining({ ordinal: 175 }),
		]);
		expect(chat.visibleRows[0]).toMatchObject({ id: 'generation-1:101', ordinal: 101 });
		expect(chat.visibleRows.at(-1)).toMatchObject({ id: 'generation-1:500', ordinal: 500 });
		expect(chat.getCursor()).toEqual({ transcriptViewId: 'generation-1', lastOrdinal: 500 });
	});

	it('bridges every gap between a retained interval and a disjoint same-view snapshot', async () => {
		const repeatedContent = 'same-text-different-ordinal';
		const chat = new ActiveTranscriptState();
		chat.replaceGeneration(
			'chat-1',
			'generation-1',
			assistantEntries(101, 300, (ordinal) =>
				ordinal === 175 ? repeatedContent : `message-${ordinal}`,
			),
			{ lastOrdinal: 300, pageOldestOrdinal: 101, hasMore: true },
		);
		chat.isUserScrolledUp = true;
		chat.revealAllLoadedMessages();

		const snapshotEpoch = chat.beginSnapshotLoad();
		expect(chat.setFromPage(
			'chat-1',
			page({
				transcriptViewId: 'generation-1',
				messages: assistantEntries(451, 500, (ordinal) =>
					ordinal === 475 ? repeatedContent : `message-${ordinal}`,
				),
				lastOrdinal: 500,
				pageOldestOrdinal: 451,
				pageNewestOrdinal: 500,
				hasMore: true,
			}),
			snapshotEpoch,
		)).toBe('applied');

		expect(chat.entries.map((message) => message.ordinal)).toEqual(
			Array.from({ length: 200 }, (_, index) => index + 101),
		);
		expect(chat.oldestOrdinal).toBe(101);
		expect(chat.loadedThroughOrdinal).toBe(300);
		expect(chat.lastOrdinal).toBe(500);
		expect(chat.hasLaterMessages).toBe(true);

		const hiddenOrdinals = new Set([320, 351, 425, 477]);
		const laterPage = (firstOrdinal: number, lastOrdinal: number) =>
			assistantEntries(firstOrdinal, lastOrdinal, (ordinal) =>
				ordinal === 475 ? repeatedContent : `message-${ordinal}`,
			).filter((message) => !hiddenOrdinals.has(message.ordinal));
		vi.mocked(getChatMessages)
			.mockResolvedValueOnce({
				chatId: 'chat-1',
				limit: 50,
				...page({
					messages: laterPage(301, 350),
					lastOrdinal: 500,
					pageOldestOrdinal: 301,
					pageNewestOrdinal: 350,
					hasMore: true,
				}),
			})
			.mockResolvedValueOnce({
				chatId: 'chat-1',
				limit: 50,
				...page({
					messages: laterPage(351, 400),
					lastOrdinal: 500,
					pageOldestOrdinal: 352,
					pageNewestOrdinal: 400,
					hasMore: true,
				}),
			})
			.mockResolvedValueOnce({
				chatId: 'chat-1',
				limit: 50,
				...page({
					messages: laterPage(401, 450),
					lastOrdinal: 500,
					pageOldestOrdinal: 401,
					pageNewestOrdinal: 450,
					hasMore: true,
				}),
			})
			.mockResolvedValueOnce({
				chatId: 'chat-1',
				limit: 50,
				...page({
					messages: laterPage(451, 500),
					lastOrdinal: 500,
					pageOldestOrdinal: 451,
					pageNewestOrdinal: 500,
					hasMore: true,
				}),
			});

		for (let pageIndex = 0; pageIndex < 4; pageIndex += 1) {
			await expect(chat.loadLaterPage('chat-1')).resolves.toBe('loaded');
		}

		for (const [index, beforeOrdinal] of [351, 401, 451, 501].entries()) {
			expect(vi.mocked(getChatMessages)).toHaveBeenNthCalledWith(index + 1, {
				chatId: 'chat-1',
				beforeOrdinal,
				limit: 50,
				transcriptViewId: 'generation-1',
			});
		}
		const expectedOrdinals = Array.from({ length: 400 }, (_, index) => index + 101)
			.filter((ordinal) => !hiddenOrdinals.has(ordinal));
		expect(chat.entries.map((message) => message.ordinal)).toEqual(expectedOrdinals);
		expect(chat.entries.filter(
			(message) => contentOf(message.message) === repeatedContent,
		)).toEqual([
			expect.objectContaining({ ordinal: 175 }),
			expect.objectContaining({ ordinal: 475 }),
		]);
		expect(chat.loadedThroughOrdinal).toBe(500);
		expect(chat.hasLaterMessages).toBe(false);
		expect(chat.getCursor()).toEqual({ transcriptViewId: 'generation-1', lastOrdinal: 500 });
	});

	it('keeps a fresh earlier request active after a snapshot invalidates its predecessor', async () => {
		const chat = new ActiveTranscriptState();
		chat.replaceGeneration('chat-1', 'generation-1', assistantEntries(201, 400), {
			lastOrdinal: 400,
			pageOldestOrdinal: 201,
			hasMore: true,
		});
		let resolveStalePage!: (value: Awaited<ReturnType<typeof getChatMessages>>) => void;
		let resolveFreshPage!: (value: Awaited<ReturnType<typeof getChatMessages>>) => void;
		vi.mocked(getChatMessages)
			.mockReturnValueOnce(new Promise((resolve) => {
				resolveStalePage = resolve;
			}))
			.mockReturnValueOnce(new Promise((resolve) => {
				resolveFreshPage = resolve;
			}));

		const staleLoad = chat.loadEarlierPage('chat-1');
		expect(chat.pageStates.earlier.status).toBe('loading');
		const snapshotEpoch = chat.beginSnapshotLoad();
		expect(chat.setFromPage(
			'chat-1',
			page({
				transcriptViewId: 'generation-1',
				messages: assistantEntries(301, 500),
				lastOrdinal: 500,
				pageOldestOrdinal: 301,
				pageNewestOrdinal: 500,
				hasMore: true,
			}),
			snapshotEpoch,
		)).toBe('applied');

		const freshLoad = chat.loadEarlierPage('chat-1');
		expect(chat.pageStates.earlier.status).toBe('loading');
		resolveStalePage({
			chatId: 'chat-1',
			limit: 50,
			...page({
				messages: assistantEntries(151, 200, (ordinal) => `stale-${ordinal}`),
				lastOrdinal: 500,
				pageOldestOrdinal: 151,
				pageNewestOrdinal: 200,
				hasMore: true,
			}),
		});
		await expect(staleLoad).resolves.toBe('invalidated');
		expect(chat.pageStates.earlier.status).toBe('loading');
		expect(chat.entries.some((message) => contentOf(message.message).startsWith('stale-')))
			.toBe(false);

		resolveFreshPage({
			chatId: 'chat-1',
			limit: 50,
			...page({
				messages: assistantEntries(151, 200),
				lastOrdinal: 500,
				pageOldestOrdinal: 151,
				pageNewestOrdinal: 200,
				hasMore: true,
			}),
		});
		await expect(freshLoad).resolves.toBe('loaded');

		expect(vi.mocked(getChatMessages)).toHaveBeenNthCalledWith(1, {
			chatId: 'chat-1',
			beforeOrdinal: 201,
			limit: 50,
			transcriptViewId: 'generation-1',
		});
		expect(vi.mocked(getChatMessages)).toHaveBeenNthCalledWith(2, {
			chatId: 'chat-1',
			beforeOrdinal: 201,
			limit: 50,
			transcriptViewId: 'generation-1',
		});
		expect(chat.entries.map((message) => message.ordinal)).toEqual(
			Array.from({ length: 350 }, (_, index) => index + 151),
		);
		expect(chat.pageStates.earlier.status).toBe('idle');
	});

	it('retires an obsolete reconnect replay when a replacement snapshot installs', () => {
		const chat = new ActiveTranscriptState();
		chat.replaceGeneration('chat-1', 'generation-old', [entry(1, assistant('old'))], {
			lastOrdinal: 1,
			pageOldestOrdinal: 1,
			hasMore: false,
		});
		const replayToken = chat.beginReconnectReplay('chat-1', 'generation-old');
		expect(chat.applyReconnectReplayPage(
			replayToken,
			'chat-1',
			'generation-old',
			[entry(2, assistant('old replay'))],
			2,
			2,
			[],
		)).toBe('applied');

		const snapshotEpoch = chat.beginSnapshotLoad();
		expect(chat.setFromPage(
			'chat-1',
			page({
				transcriptViewId: 'generation-new',
				messages: [entry(1, assistant('replacement'))],
				lastOrdinal: 1,
			}),
			snapshotEpoch,
		)).toBe('applied');
		expect(applyMessages(
			chat,
			'chat-1',
			'generation-new',
			[entry(2, assistant('replacement live'))],
		)).toBe('applied');

		expect(chat.chatMessages.map(contentOf)).toEqual(['replacement', 'replacement live']);
		expect(chat.getCursor()).toEqual({ transcriptViewId: 'generation-new', lastOrdinal: 2 });
		expect(chat.finishReconnectReplay(replayToken, 'chat-1')).toBe('stale');
	});

	it('preserves live rows buffered before a same-view snapshot retires reconnect replay', () => {
		const chat = new ActiveTranscriptState();
		chat.replaceGeneration('chat-1', 'generation-1', [entry(1, assistant('initial'))], {
			lastOrdinal: 1,
			pageOldestOrdinal: 1,
			hasMore: false,
		});
		const replayToken = chat.beginReconnectReplay('chat-1', 'generation-1');
		const snapshotEpoch = chat.beginSnapshotLoad();

		expect(applyMessages(
			chat,
			'chat-1',
			'generation-1',
			[entry(2, assistant('live during snapshot'))],
		)).toBe('applied');
		expect(chat.setFromPage(
			'chat-1',
			page({
				transcriptViewId: 'generation-1',
				messages: [entry(1, assistant('initial'))],
				lastOrdinal: 1,
			}),
			snapshotEpoch,
		)).toBe('applied');

		expect(chat.chatMessages.map(contentOf)).toEqual(['initial', 'live during snapshot']);
		expect(chat.getCursor()).toEqual({ transcriptViewId: 'generation-1', lastOrdinal: 2 });
		expect(chat.finishReconnectReplay(replayToken, 'chat-1')).toBe('stale');
	});

	it('preserves replacement-view live rows buffered before its snapshot installs', () => {
		const chat = new ActiveTranscriptState();
		chat.replaceGeneration('chat-1', 'generation-old', [entry(1, assistant('old'))], {
			lastOrdinal: 1,
			pageOldestOrdinal: 1,
			hasMore: false,
		});
		const replayToken = chat.beginReconnectReplay('chat-1', 'generation-old');
		const snapshotEpoch = chat.beginSnapshotLoad();

		expect(applyMessages(
			chat,
			'chat-1',
			'generation-new',
			[entry(2, assistant('replacement live'))],
		)).toBe('applied');
		expect(chat.setFromPage(
			'chat-1',
			page({
				transcriptViewId: 'generation-new',
				messages: [entry(1, assistant('replacement snapshot'))],
				lastOrdinal: 1,
			}),
			snapshotEpoch,
		)).toBe('applied');

		expect(chat.chatMessages.map(contentOf)).toEqual([
			'replacement snapshot',
			'replacement live',
		]);
		expect(chat.getCursor()).toEqual({ transcriptViewId: 'generation-new', lastOrdinal: 2 });
		expect(chat.finishReconnectReplay(replayToken, 'chat-1')).toBe('stale');
	});

	it('keeps reconnect replay active when a snapshot installation is stale', () => {
		const chat = new ActiveTranscriptState();
		chat.replaceGeneration('chat-1', 'generation-1', [entry(1, assistant('initial'))], {
			lastOrdinal: 1,
			pageOldestOrdinal: 1,
			hasMore: false,
		});
		const replayToken = chat.beginReconnectReplay('chat-1', 'generation-1');
		const staleSnapshotEpoch = chat.beginSnapshotLoad();
		const currentSnapshotEpoch = chat.beginSnapshotLoad();

		expect(chat.setFromPage(
			'chat-1',
			page({
				transcriptViewId: 'generation-1',
				messages: [entry(1, assistant('stale snapshot'))],
				lastOrdinal: 1,
			}),
			staleSnapshotEpoch,
		)).toBe('stale');
		chat.abortSnapshotLoad(currentSnapshotEpoch);
		expect(chat.applyReconnectReplayPage(
			replayToken,
			'chat-1',
			'generation-1',
			[entry(2, assistant('replayed'))],
			2,
			2,
			[],
		)).toBe('applied');
		expect(chat.finishReconnectReplay(replayToken, 'chat-1')).toBe('applied');

		expect(chat.chatMessages.map(contentOf)).toEqual(['initial', 'replayed']);
		expect(chat.getCursor()).toEqual({ transcriptViewId: 'generation-1', lastOrdinal: 2 });
	});

	it('clears optimistic rows when a transcript view is replaced', () => {
		const chat = new ActiveTranscriptState();
		chat.upsertOptimisticUserInput(optimisticInput());

		chat.replaceGeneration(
			'chat-1',
			'generation-2',
			[entry(1, assistant('native'))],
			{ lastOrdinal: 1, pageOldestOrdinal: 1, hasMore: false },
		);

		expect(chat.optimisticUserInputs).toEqual([]);
		expect(chat.chatMessages.map(contentOf)).toEqual(['native']);
	});

	it('clears optimistic rows when a snapshot replaces the transcript view', () => {
		const chat = new ActiveTranscriptState();
		applyMessages(chat, 'chat-1', 'generation-1', [entry(1, assistant('current'))]);
		chat.upsertOptimisticUserInput(optimisticInput());
		const epoch = chat.beginSnapshotLoad();

		expect(chat.setFromPage(
			'chat-1',
			page({
				transcriptViewId: 'generation-2',
				messages: [entry(1, assistant('reloaded'))],
				lastOrdinal: 1,
			}),
			epoch,
		)).toBe('applied');

		expect(chat.optimisticUserInputs).toEqual([]);
		expect(chat.chatMessages.map(contentOf)).toEqual(['reloaded']);
	});

	it('persists and activates generation-scoped transcript windows', () => {
		const chat = new ActiveTranscriptState();
		applyMessages(chat, 'chat-1', 'generation-1', [
			entry(1, user('first')),
			entry(2, assistant('second')),
		]);
		chat.transcriptCache.flush();

		const restored = new ActiveTranscriptState();
		const result = restored.activateChat('chat-1');

		expect(result).toEqual({ count: 2, stale: false });
		expect(restored.getCursor()).toEqual({ transcriptViewId: 'generation-1', lastOrdinal: 2 });
		expect(restored.chatMessages.map(contentOf)).toEqual(['first', 'second']);
	});

	it('restores the bounded transcript window immediately', () => {
		const transcriptCache = new ChatTranscriptCache({ limit: 100 });
		const messages = Array.from({ length: 100 }, (_, index) =>
			entry(index + 1, assistant(`message-${index + 1}`)),
		);
		transcriptCache.replaceFromPage('chat-1', {
			transcriptViewId: 'generation-1',
			messages,
			lastOrdinal: 100,
			pageOldestOrdinal: 1,
			pageNewestOrdinal: 100,
			hasMore: false,
		});
		const chat = new ActiveTranscriptState(transcriptCache);

		chat.activateChat('chat-1');

		expect(chat.visibleRows).toHaveLength(100);
		expect(chat.visibleMessageCount).toBe(INITIAL_VISIBLE_MESSAGES);
	});

	it('restores the earlier-page boundary with a cached tail window', () => {
		const transcriptCache = new ChatTranscriptCache({ limit: 100 });
		const messages = Array.from({ length: 100 }, (_, index) =>
			entry(index + 101, assistant(`message-${index + 101}`)),
		);
		transcriptCache.replaceFromPage('chat-1', {
			transcriptViewId: 'generation-1',
			messages,
			lastOrdinal: 200,
			pageOldestOrdinal: 101,
			pageNewestOrdinal: 200,
			hasMore: true,
		});
		const chat = new ActiveTranscriptState(transcriptCache);

		chat.activateChat('chat-1');

		expect(chat.canLoadEarlier).toBe(true);
	});

	it('keeps a partial restored transcript visible through later growth', () => {
		const transcriptCache = new ChatTranscriptCache({ limit: 100 });
		const messages = Array.from({ length: 30 }, (_, index) =>
			entry(index + 1, assistant(`message-${index + 1}`)),
		);
		transcriptCache.replaceFromPage('chat-1', {
			transcriptViewId: 'generation-1',
			messages,
			lastOrdinal: 30,
			pageOldestOrdinal: 1,
			pageNewestOrdinal: 30,
			hasMore: false,
		});
		const chat = new ActiveTranscriptState(transcriptCache);

		chat.activateChat('chat-1');

		expect(chat.visibleRows).toHaveLength(30);
		expect(chat.visibleMessageCount).toBe(INITIAL_VISIBLE_MESSAGES);

		applyMessages(chat,
			'chat-1',
			'generation-1',
			Array.from({ length: 30 }, (_, index) =>
				entry(index + 31, assistant(`message-${index + 31}`)),
			),
		);

		expect(chat.visibleRows).toHaveLength(60);
	});

	it('does not narrow a partial window while checking for loaded earlier rows', () => {
		const chat = new ActiveTranscriptState();
		const messages = Array.from({ length: 51 }, (_, index) =>
			entry(index + 50, assistant(`message-${index + 50}`)),
		);
		chat.replaceGeneration('chat-1', 'generation-1', messages, {
			lastOrdinal: 100,
			pageOldestOrdinal: 50,
			hasMore: true,
		});

		expect(chat.revealEarlierLoadedRows()).toBe(false);
		expect(chat.visibleMessageCount).toBe(INITIAL_VISIBLE_MESSAGES);

		applyMessages(chat, 'chat-1', 'generation-1', [entry(101, assistant('live'))]);

		expect(chat.visibleRows[0]).toMatchObject({ id: 'generation-1:50', ordinal: 50 });
		expect(chat.visibleRows).toHaveLength(52);
	});

	it('keeps every explicitly revealed row visible as live messages append', () => {
		const chat = new ActiveTranscriptState();
		const messages = Array.from({ length: 175 }, (_, index) =>
			entry(index + 1, assistant(`message-${index + 1}`)),
		);
		chat.replaceGeneration('chat-1', 'generation-1', messages, {
			lastOrdinal: 175,
			pageOldestOrdinal: 1,
			hasMore: false,
		});

		expect(chat.visibleRows).toHaveLength(INITIAL_VISIBLE_MESSAGES);
		chat.revealAllLoadedMessages();

		expect(chat.visibleRows).toHaveLength(175);
		expect(chat.visibleRows[0]).toMatchObject({ id: 'generation-1:1', ordinal: 1 });

		chat.upsertOptimisticUserInput(
			optimisticInput({ clientMessageId: 'message-176', content: 'message-176' }),
		);
		applyMessages(chat, 'chat-1', 'generation-1', [
			entry(176, user('message-176', { clientMessageId: 'message-176' })),
		]);
		applyMessages(chat, 'chat-1', 'generation-1', [entry(177, assistant('message-177'))]);

		expect(chat.visibleRows).toHaveLength(177);
		expect(chat.visibleRows[0]).toMatchObject({ id: 'generation-1:1', ordinal: 1 });
	});

	it('does not re-arm expanded-window growth from replacement-generation count slack', async () => {
		const chat = new ActiveTranscriptState();
		chat.replaceGeneration(
			'chat-1',
			'generation-1',
			Array.from({ length: 175 }, (_, index) => entry(index + 1, assistant(`old-${index + 1}`))),
			{ lastOrdinal: 175, pageOldestOrdinal: 1, hasMore: false },
		);
		chat.revealAllLoadedMessages();
		const epoch = chat.beginSnapshotLoad();

		expect(
			chat.setFromPage(
				'chat-1',
				page({
					transcriptViewId: 'generation-2',
					messages: Array.from({ length: 50 }, (_, index) =>
						entry(index + 51, assistant(`new-${index + 51}`)),
					),
					lastOrdinal: 100,
					pageOldestOrdinal: 51,
					hasMore: true,
				}),
				epoch,
			),
		).toBe('applied');
		expect(chat.visibleMessageCount).toBe(INITIAL_VISIBLE_MESSAGES);

		vi.mocked(getChatMessages).mockResolvedValueOnce({
			chatId: 'chat-1',
			limit: 50,
			...page({
				transcriptViewId: 'generation-2',
				messages: Array.from({ length: 50 }, (_, index) =>
					entry(index + 1, assistant(`new-${index + 1}`)),
				),
				lastOrdinal: 100,
				pageOldestOrdinal: 1,
				hasMore: false,
			}),
		});
		await expect(chat.loadEarlierPage('chat-1')).resolves.toBe('loaded');
		applyMessages(chat,
			'chat-1',
			'generation-2',
			Array.from({ length: 126 }, (_, index) =>
				entry(index + 101, assistant(`new-${index + 101}`)),
			),
		);

		expect(chat.visibleRows).toHaveLength(150);
		expect(chat.visibleRows[0]).toMatchObject({ id: 'generation-2:77', ordinal: 77 });
	});

	it('retains expanded-window growth across a same-generation snapshot', () => {
		const chat = new ActiveTranscriptState();
		const messages = Array.from({ length: 175 }, (_, index) =>
			entry(index + 1, assistant(`message-${index + 1}`)),
		);
		chat.replaceGeneration('chat-1', 'generation-1', messages, {
			lastOrdinal: 175,
			pageOldestOrdinal: 1,
			hasMore: false,
		});
		chat.revealAllLoadedMessages();
		const epoch = chat.beginSnapshotLoad();

		expect(
			chat.setFromPage(
				'chat-1',
				page({
					transcriptViewId: 'generation-1',
					messages,
					lastOrdinal: 175,
					pageOldestOrdinal: 1,
				}),
				epoch,
			),
		).toBe('applied');
		applyMessages(chat, 'chat-1', 'generation-1', [entry(176, assistant('message-176'))]);

		expect(chat.visibleRows).toHaveLength(176);
		expect(chat.visibleRows[0]).toMatchObject({ id: 'generation-1:1', ordinal: 1 });
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
					transcriptViewId: 'generation-1',
					messages: Array.from({ length: messageCount }, (_, index) =>
						entry(index + 1, assistant(`message-${index + 1}`)),
					),
					lastOrdinal: messageCount,
					pageOldestOrdinal: messageCount === 0 ? 0 : 1,
					pageNewestOrdinal: messageCount,
					hasMore: false,
				},
				epoch,
			);

			expect(chat.visibleMessageCount).toBe(INITIAL_VISIBLE_MESSAGES);

			applyMessages(chat,
				'chat-1',
				'generation-1',
				Array.from({ length: 40 - messageCount }, (_, index) =>
					entry(messageCount + index + 1, assistant(`new-${index + 1}`)),
				),
			);

			expect(chat.visibleRows).toHaveLength(40);
		},
	);

	it('bounds the first loaded window when a switched chat is not cached yet', () => {
		const chat = new ActiveTranscriptState();
		const messages = Array.from({ length: 100 }, (_, index) =>
			entry(index + 1, assistant(`message-${index + 1}`)),
		);

		expect(chat.activateChat('chat-1')).toBeNull();
		const epoch = chat.beginSnapshotLoad();
		chat.setFromPage(
			'chat-1',
			{
				transcriptViewId: 'generation-1',
				messages,
				lastOrdinal: 100,
				pageOldestOrdinal: 1,
				pageNewestOrdinal: 100,
				hasMore: false,
			},
			epoch,
		);

		expect(chat.visibleRows).toHaveLength(INITIAL_VISIBLE_MESSAGES);
	});

	it('loads only the first page for initial-prompt navigation', async () => {
		const chat = new ActiveTranscriptState();
		chat.replaceGeneration(
			'chat-1',
			'generation-1',
			Array.from({ length: 50 }, (_, index) =>
				entry(index + 5_995, assistant(`message-${index + 5_995}`)),
			),
			{ lastOrdinal: 6_044, pageOldestOrdinal: 5_995, hasMore: true },
		);
		vi.mocked(getChatMessages).mockResolvedValueOnce({
			chatId: 'chat-1',
			limit: 50,
			...page({
				messages: Array.from({ length: 50 }, (_, index) =>
					entry(index + 1, assistant(`message-${index + 1}`)),
				),
				lastOrdinal: 6_044,
				pageOldestOrdinal: 1,
				hasMore: false,
			}),
		});

		await expect(chat.navigateToWindow('chat-1', 'initial')).resolves.toBe('loaded');

		expect(getChatMessages).toHaveBeenCalledOnce();
		expect(getChatMessages).toHaveBeenCalledWith({
			chatId: 'chat-1',
			limit: 50,
			beforeOrdinal: 51,
			transcriptViewId: 'generation-1',
		});
		expect(chat.visibleRows).toHaveLength(50);
		expect(chat.visibleRows[0]).toMatchObject({ kind: 'message', ordinal: 1 });
		expect(chat.visibleRows.at(-1)).toMatchObject({ kind: 'message', ordinal: 50 });
		expect(chat.hasLaterMessages).toBe(true);
		expect(chat.getCursor()).toEqual({ transcriptViewId: 'generation-1', lastOrdinal: 6_044 });
		expect(chat.transcriptCache.get('chat-1')?.messages[0]).toMatchObject({ ordinal: 5_995 });
	});

	it('pages forward from the initial window until it rejoins the live transcript', async () => {
		const chat = new ActiveTranscriptState();
		chat.replaceGeneration(
			'chat-1',
			'generation-1',
			Array.from({ length: 50 }, (_, index) =>
				entry(index + 71, assistant(`message-${index + 71}`)),
			),
			{ lastOrdinal: 120, pageOldestOrdinal: 71, hasMore: true },
		);
		vi.mocked(getChatMessages)
			.mockResolvedValueOnce({
				chatId: 'chat-1',
				limit: 50,
				...page({
					messages: Array.from({ length: 50 }, (_, index) =>
						entry(index + 1, assistant(`message-${index + 1}`)),
					),
					lastOrdinal: 120,
					pageOldestOrdinal: 1,
				}),
			})
			.mockResolvedValueOnce({
				chatId: 'chat-1',
				limit: 50,
				...page({
					messages: Array.from({ length: 50 }, (_, index) =>
						entry(index + 51, assistant(`message-${index + 51}`)),
					),
					lastOrdinal: 120,
					pageOldestOrdinal: 51,
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
					lastOrdinal: 120,
					pageOldestOrdinal: 71,
					hasMore: true,
				}),
			});

		await expect(chat.navigateToWindow('chat-1', 'initial')).resolves.toBe('loaded');
		await expect(chat.loadLaterPage('chat-1')).resolves.toBe('loaded');

		expect(getChatMessages).toHaveBeenNthCalledWith(2, {
			chatId: 'chat-1',
			limit: 50,
			beforeOrdinal: 101,
			transcriptViewId: 'generation-1',
		});
		expect(chat.entries).toHaveLength(100);
		expect(chat.entries.at(-1)).toMatchObject({ ordinal: 100 });
		expect(chat.hasLaterMessages).toBe(true);

		await expect(chat.loadLaterPage('chat-1')).resolves.toBe('loaded');

		expect(getChatMessages).toHaveBeenNthCalledWith(3, {
			chatId: 'chat-1',
			limit: 50,
			beforeOrdinal: 121,
			transcriptViewId: 'generation-1',
		});
		expect(chat.entries).toHaveLength(120);
		expect(chat.visibleRows).toHaveLength(120);
		expect(chat.hasLaterMessages).toBe(false);
		expect(chat.getCursor()).toEqual({ transcriptViewId: 'generation-1', lastOrdinal: 120 });
		expect(chat.transcriptCache.get('chat-1')?.messages[0]).toMatchObject({ ordinal: 71 });
	});

	it('chases live messages that arrive while paging forward from the initial window', async () => {
		const chat = new ActiveTranscriptState();
		chat.replaceGeneration(
			'chat-1',
			'generation-1',
			Array.from({ length: 50 }, (_, index) =>
				entry(index + 51, assistant(`message-${index + 51}`)),
			),
			{ lastOrdinal: 100, pageOldestOrdinal: 51, hasMore: true },
		);
		vi.mocked(getChatMessages)
			.mockResolvedValueOnce({
				chatId: 'chat-1',
				limit: 50,
				...page({
					messages: Array.from({ length: 50 }, (_, index) =>
						entry(index + 1, assistant(`message-${index + 1}`)),
					),
					lastOrdinal: 100,
					pageOldestOrdinal: 1,
				}),
			})
			.mockResolvedValueOnce({
				chatId: 'chat-1',
				limit: 50,
				...page({
					messages: Array.from({ length: 50 }, (_, index) =>
						entry(index + 51, assistant(`message-${index + 51}`)),
					),
					lastOrdinal: 102,
					pageOldestOrdinal: 51,
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
					lastOrdinal: 102,
					pageOldestOrdinal: 53,
					hasMore: true,
				}),
			});

		await expect(chat.navigateToWindow('chat-1', 'initial')).resolves.toBe('loaded');
		expect(
			applyMessages(chat, 'chat-1', 'generation-1', [
				entry(101, assistant('message-101')),
				entry(102, assistant('message-102')),
			]),
		).toBe('applied');

		await expect(chat.loadLaterPage('chat-1')).resolves.toBe('loaded');
		expect(chat.entries.at(-1)).toMatchObject({ ordinal: 100 });
		expect(chat.hasLaterMessages).toBe(true);
		expect(chat.getCursor()).toEqual({ transcriptViewId: 'generation-1', lastOrdinal: 102 });

		await expect(chat.loadLaterPage('chat-1')).resolves.toBe('loaded');
		expect(chat.entries.map((item) => item.ordinal)).toEqual(
			Array.from({ length: 102 }, (_, index) => index + 1),
		);
		expect(chat.hasLaterMessages).toBe(false);
		expect(chat.getCursor()).toEqual({ transcriptViewId: 'generation-1', lastOrdinal: 102 });
	});

	it('coalesces concurrent forward page requests for the detached window', async () => {
		const chat = new ActiveTranscriptState();
		chat.replaceGeneration(
			'chat-1',
			'generation-1',
			Array.from({ length: 50 }, (_, index) =>
				entry(index + 51, assistant(`message-${index + 51}`)),
			),
			{ lastOrdinal: 100, pageOldestOrdinal: 51, hasMore: true },
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
					lastOrdinal: 100,
					pageOldestOrdinal: 1,
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
				lastOrdinal: 100,
				pageOldestOrdinal: 51,
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
			{ lastOrdinal: 100, pageOldestOrdinal: 51, hasMore: true },
		);
		vi.mocked(getChatMessages)
			.mockResolvedValueOnce({
				chatId: 'chat-1',
				limit: 50,
				...page({
					messages: Array.from({ length: 50 }, (_, index) =>
						entry(index + 1, assistant(`message-${index + 1}`)),
					),
					lastOrdinal: 100,
					pageOldestOrdinal: 1,
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
					lastOrdinal: 100,
					pageOldestOrdinal: 51,
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
			{ lastOrdinal: 100, pageOldestOrdinal: 51, hasMore: true },
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
				lastOrdinal: 101,
				pageOldestOrdinal: 1,
				hasMore: false,
			}),
		});

		await expect(initial).resolves.toBe('loaded');
		expect(chat.hasLaterMessages).toBe(true);
		expect(chat.getCursor()).toEqual({ transcriptViewId: 'generation-1', lastOrdinal: 100 });
		expect(chat.transcriptCache.get('chat-1')?.lastOrdinal).toBe(100);

		expect(applyMessages(chat, 'chat-1', 'generation-1', [entry(101, assistant('unseen'))])).toBe(
			'applied',
		);
		expect(chat.getCursor()).toEqual({ transcriptViewId: 'generation-1', lastOrdinal: 101 });
	});

	it('keeps the latest window when Bottom supersedes a pending Initial request', async () => {
		const chat = new ActiveTranscriptState();
		const latestWindow = Array.from({ length: 50 }, (_, index) =>
			entry(index + 51, assistant(`latest-${index + 51}`)),
		);
		chat.replaceGeneration('chat-1', 'generation-1', latestWindow, {
			lastOrdinal: 100,
			pageOldestOrdinal: 51,
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
				lastOrdinal: 100,
				pageOldestOrdinal: 1,
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
			lastOrdinal: 100,
			pageOldestOrdinal: 51,
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
				lastOrdinal: 100,
				pageOldestOrdinal: 1,
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
			{ lastOrdinal: 100, pageOldestOrdinal: 51, hasMore: true },
		);
		chat.entries = Array.from({ length: 50 }, (_, index) =>
			entry(index + 1, assistant(`initial-${index + 1}`)),
		);
		chat.oldestOrdinal = 1;
		chat.hasEarlierMessages = false;
		chat.hasLaterMessages = true;
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
				lastOrdinal: 100,
				pageOldestOrdinal: 51,
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
			{ lastOrdinal: 100, pageOldestOrdinal: 51, hasMore: true },
		);
		chat.entries = Array.from({ length: 50 }, (_, index) =>
			entry(index + 1, assistant(`initial-${index + 1}`)),
		);
		chat.oldestOrdinal = 1;
		chat.hasEarlierMessages = false;
		chat.hasLaterMessages = true;
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
			{ lastOrdinal: 100, pageOldestOrdinal: 51, hasMore: true },
		);
		vi.mocked(getChatMessages).mockResolvedValueOnce({
			chatId: 'chat-1',
			limit: 50,
			...page({
				messages: Array.from({ length: 50 }, (_, index) =>
					entry(index + 1, assistant(`message-${index + 1}`)),
				),
				lastOrdinal: 100,
				pageOldestOrdinal: 1,
				hasMore: false,
			}),
		});

		await chat.navigateToWindow('chat-1', 'initial');
		chat.upsertOptimisticUserInput(optimisticInput({ content: 'optimistic-tail' }));
		chat.appendLocalNotice('progress', 'tail-only status');
		expect(chat.visibleRows).toHaveLength(50);
		expect(applyMessages(chat, 'chat-1', 'generation-1', [entry(101, assistant('live-tail'))])).toBe(
			'applied',
		);

		expect(chat.visibleRows).toHaveLength(50);
		expect(chat.visibleRows.at(-1)).toMatchObject({ kind: 'message', ordinal: 50 });
		expect(chat.getCursor()).toEqual({ transcriptViewId: 'generation-1', lastOrdinal: 101 });
		expect(chat.transcriptCache.get('chat-1')?.messages.at(-1)).toMatchObject({ ordinal: 101 });

		vi.mocked(getChatMessages).mockResolvedValueOnce({
			chatId: 'chat-1',
			limit: 50,
			...page({
				messages: Array.from({ length: 50 }, (_, index) =>
					entry(index + 52, assistant(`message-${index + 52}`)),
				),
				lastOrdinal: 101,
				pageOldestOrdinal: 52,
				hasMore: true,
			}),
		});
		await chat.navigateToWindow('chat-1', 'latest');
		expect(vi.mocked(getChatMessages)).toHaveBeenLastCalledWith({
			chatId: 'chat-1',
			limit: 50,
			transcriptViewId: 'generation-1',
		});

		expect(chat.hasLaterMessages).toBe(false);
		expect(chat.visibleRows.at(-1)).toMatchObject({ kind: 'message', ordinal: 101 });
	});

	it('replays live messages that arrive while restoring the latest window', async () => {
		const chat = new ActiveTranscriptState();
		chat.replaceGeneration(
			'chat-1',
			'generation-1',
			Array.from({ length: 50 }, (_, index) =>
				entry(index + 51, assistant(`latest-${index + 51}`)),
			),
			{ lastOrdinal: 100, pageOldestOrdinal: 51, hasMore: true },
		);
		chat.entries = Array.from({ length: 50 }, (_, index) =>
			entry(index + 1, assistant(`initial-${index + 1}`)),
		);
		chat.oldestOrdinal = 1;
		chat.loadedThroughOrdinal = 50;
		chat.hasEarlierMessages = false;
		chat.hasLaterMessages = true;
		chat.visibleMessageCount = 50;
		let resolveLatest!: (value: Awaited<ReturnType<typeof getChatMessages>>) => void;
		vi.mocked(getChatMessages).mockReturnValueOnce(
			new Promise((resolve) => {
				resolveLatest = resolve;
			}),
		);

		const latest = chat.navigateToWindow('chat-1', 'latest');
		expect(applyMessages(chat, 'chat-1', 'generation-1', [entry(101, assistant('live'))])).toBe(
			'applied',
		);
		resolveLatest({
			chatId: 'chat-1',
			limit: 50,
			...page({
				messages: Array.from({ length: 50 }, (_, index) =>
					entry(index + 51, assistant(`latest-${index + 51}`)),
				),
				lastOrdinal: 100,
				pageOldestOrdinal: 51,
				hasMore: true,
			}),
		});

		await expect(latest).resolves.toBe('loaded');
		expect(chat.entries.at(-1)).toMatchObject({ ordinal: 101, message: { content: 'live' } });
		expect(chat.transcriptCache.get('chat-1')?.messages.at(-1)).toMatchObject({ ordinal: 101 });
		expect(chat.getCursor()).toEqual({ transcriptViewId: 'generation-1', lastOrdinal: 101 });
	});

	it('keeps the newest resend candidates when live rows overtake a latest-window response', async () => {
		const chat = new ActiveTranscriptState();
		chat.replaceGeneration(
			'chat-1',
			'generation-1',
			Array.from({ length: 50 }, (_, index) =>
				entry(index + 51, assistant(`latest-${index + 51}`)),
			),
			{ lastOrdinal: 100, pageOldestOrdinal: 51, hasMore: true },
		);
		chat.entries = Array.from({ length: 50 }, (_, index) =>
			entry(index + 1, assistant(`initial-${index + 1}`)),
		);
		chat.oldestOrdinal = 1;
		chat.loadedThroughOrdinal = 50;
		chat.hasEarlierMessages = false;
		chat.hasLaterMessages = true;
		chat.visibleMessageCount = 50;
		const responseCandidate = {
			ordinal: 45,
			content: 'candidate captured with the response',
			attachmentNames: [],
		};
		const liveCandidate = {
			ordinal: 101,
			content: 'candidate published with the live row',
			attachmentNames: ['live.txt'],
		};
		let resolveLatest!: (value: Awaited<ReturnType<typeof getChatMessages>>) => void;
		vi.mocked(getChatMessages).mockReturnValueOnce(
			new Promise((resolve) => {
				resolveLatest = resolve;
			}),
		);

		const latest = chat.navigateToWindow('chat-1', 'latest');
		expect(
			chat.applyMessages(
				'chat-1',
				'generation-1',
				[entry(101, assistant('live'))],
				101,
				101,
				[liveCandidate],
			),
		).toBe('applied');
		resolveLatest({
			chatId: 'chat-1',
			limit: 50,
			...page({
				messages: Array.from({ length: 50 }, (_, index) =>
					entry(index + 51, assistant(`latest-${index + 51}`)),
				),
				lastOrdinal: 100,
				pageOldestOrdinal: 51,
				hasMore: true,
				resendCandidates: [responseCandidate],
			}),
		});

		await expect(latest).resolves.toBe('loaded');
		expect(chat.entries.at(-1)).toMatchObject({ ordinal: 101, message: { content: 'live' } });
		expect(chat.resendCandidates).toEqual([liveCandidate]);
	});

	it.each([
		{
			name: 'add',
			mutate: (chat: ActiveTranscriptState) =>
				chat.upsertOptimisticUserInput(
					optimisticInput({
						clientMessageId: 'msg-2',
						content: 'added',
						createdAt: '2026-06-01T00:00:01.000Z',
					}),
				),
			expected: [
				optimisticInput(),
				optimisticInput({
					clientMessageId: 'msg-2',
					content: 'added',
					createdAt: '2026-06-01T00:00:01.000Z',
				}),
			],
		},
		{
			name: 'update',
			mutate: (chat: ActiveTranscriptState) =>
				chat.upsertOptimisticUserInput(optimisticInput({ content: 'updated' })),
			expected: [optimisticInput({ content: 'updated' })],
		},
		{
			name: 'clear',
			mutate: (chat: ActiveTranscriptState) => chat.clearOptimisticUserInput('msg-1'),
			expected: [],
		},
	])(
		'preserves an optimistic-input $name while restoring the latest window',
		async ({ mutate, expected }) => {
			const chat = new ActiveTranscriptState();
			chat.replaceGeneration(
				'chat-1',
				'generation-1',
				Array.from({ length: 50 }, (_, index) =>
					entry(index + 51, assistant(`latest-${index + 51}`)),
				),
				{ lastOrdinal: 100, pageOldestOrdinal: 51, hasMore: true },
			);
			chat.upsertOptimisticUserInput(optimisticInput());
			chat.entries = Array.from({ length: 50 }, (_, index) =>
				entry(index + 1, assistant(`initial-${index + 1}`)),
			);
			chat.oldestOrdinal = 1;
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
					lastOrdinal: 100,
					pageOldestOrdinal: 51,
					hasMore: true,
				}),
			});

			await expect(latest).resolves.toBe('loaded');
			expect(chat.optimisticUserInputs).toEqual(expected);
		},
	);

	it('discards an earlier page invalidated by explicit navigation', async () => {
		const chat = new ActiveTranscriptState();
		const latestWindow = Array.from({ length: 50 }, (_, index) =>
			entry(index + 51, assistant(`message-${index + 51}`)),
		);
		chat.replaceGeneration('chat-1', 'generation-1', latestWindow, {
			lastOrdinal: 100,
			pageOldestOrdinal: 51,
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
				lastOrdinal: 100,
				pageOldestOrdinal: 1,
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
			transcriptViewId: 'generation-2',
			messages: Array.from({ length: 30 }, (_, index) =>
				entry(index + 1, assistant(`chat-2-message-${index + 1}`)),
			),
			lastOrdinal: 30,
			pageOldestOrdinal: 1,
			pageNewestOrdinal: 30,
			hasMore: false,
		});
		const chat = new ActiveTranscriptState(transcriptCache);
		chat.replaceGeneration(
			'chat-1',
			'generation-1',
			Array.from({ length: 50 }, (_, index) =>
				entry(index + 51, assistant(`chat-1-message-${index + 51}`)),
			),
			{ lastOrdinal: 100, pageOldestOrdinal: 51, hasMore: true },
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
		expect(chat.visibleRows).toHaveLength(30);

		resolvePage({
			chatId: 'chat-1',
			limit: 50,
			...page({
				messages: Array.from({ length: 50 }, (_, index) =>
					entry(index + 1, assistant(`chat-1-message-${index + 1}`)),
				),
				lastOrdinal: 100,
				pageOldestOrdinal: 1,
				hasMore: false,
			}),
		});
		await expect(initialLoad).resolves.toBe('invalidated');

		expect(chat.activeChatId).toBe('chat-2');
		expect(chat.visibleRows).toHaveLength(30);
	});

	it('lets a new chat paginate while the previous chat page request is still pending', async () => {
		const chat = new ActiveTranscriptState();
		chat.replaceGeneration(
			'chat-1',
			'generation-1',
			Array.from({ length: 50 }, (_, index) =>
				entry(index + 51, assistant(`chat-1-message-${index + 51}`)),
			),
			{ lastOrdinal: 100, pageOldestOrdinal: 51, hasMore: true },
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
			{ lastOrdinal: 100, pageOldestOrdinal: 51, hasMore: true },
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
				lastOrdinal: 100,
				pageOldestOrdinal: 1,
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
				transcriptViewId: 'generation-2',
				messages: Array.from({ length: 50 }, (_, index) =>
					entry(index + 1, assistant(`chat-2-message-${index + 1}`)),
				),
				lastOrdinal: 100,
				pageOldestOrdinal: 1,
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
			{ lastOrdinal: 100, pageOldestOrdinal: 51, hasMore: true },
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
					transcriptViewId: 'generation-2',
					messages: Array.from({ length: 50 }, (_, index) =>
						entry(index + 1, assistant(`chat-2-message-${index + 1}`)),
					),
					lastOrdinal: 100,
					pageOldestOrdinal: 1,
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
			{ lastOrdinal: 100, pageOldestOrdinal: 51, hasMore: true },
		);

		await expect(chat.navigateToWindow('chat-2', 'initial')).resolves.toBe('loaded');

		expect(getChatMessages).toHaveBeenCalledTimes(2);
		expect(chat.hasEarlierMessages).toBe(false);
		expect(chat.visibleRows).toHaveLength(50);
		expect(chat.visibleRows[0]).toMatchObject({ kind: 'message', ordinal: 1 });
		expect(chat.visibleRows.at(-1)).toMatchObject({ kind: 'message', ordinal: 50 });
		expect(chat.hasLaterMessages).toBe(true);
		expect(chat.pageStates.earlier.status).toBe('idle');

		resolveOldPage({
			chatId: 'chat-1',
			limit: 50,
			...page({
				messages: Array.from({ length: 50 }, (_, index) =>
					entry(index + 1, assistant(`chat-1-message-${index + 1}`)),
				),
				lastOrdinal: 100,
				pageOldestOrdinal: 1,
				hasMore: false,
			}),
		});
		await expect(oldLoad).resolves.toBe('invalidated');

		expect(chat.activeChatId).toBe('chat-2');
		expect(chat.visibleRows[0]).toMatchObject({ kind: 'message', ordinal: 1 });
		expect(chat.pageStates.earlier.status).toBe('idle');
	});

	it('rejects an old page after switching away and back to the same chat generation', async () => {
		const chat = new ActiveTranscriptState();
		const latestWindow = Array.from({ length: 50 }, (_, index) =>
			entry(index + 51, assistant(`chat-1-message-${index + 51}`)),
		);
		chat.replaceGeneration('chat-1', 'generation-1', latestWindow, {
			lastOrdinal: 100,
			pageOldestOrdinal: 51,
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
			lastOrdinal: 1,
			pageOldestOrdinal: 1,
			hasMore: false,
		});
		chat.activateChat('chat-1');
		chat.replaceGeneration('chat-1', 'generation-1', latestWindow, {
			lastOrdinal: 100,
			pageOldestOrdinal: 51,
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
				lastOrdinal: 100,
				pageOldestOrdinal: 1,
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
				lastOrdinal: 100,
				pageOldestOrdinal: 1,
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
			{ lastOrdinal: 100, pageOldestOrdinal: 51, hasMore: true },
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
			{ lastOrdinal: 100, pageOldestOrdinal: 51, hasMore: true },
		);
		const newLoad = chat.loadEarlierPage('chat-1');

		expect(getChatMessages).toHaveBeenCalledTimes(2);
		resolveOldPage({
			chatId: 'chat-1',
			limit: 50,
			...page({
				transcriptViewId: 'generation-1',
				messages: Array.from({ length: 50 }, (_, index) =>
					entry(index + 1, assistant(`generation-1-message-${index + 1}`)),
				),
				lastOrdinal: 100,
				pageOldestOrdinal: 1,
				hasMore: false,
			}),
		});
		await expect(oldLoad).resolves.toBe('invalidated');

		expect(chat.transcriptViewId).toBe('generation-2');
		expect(chat.chatMessages[0]).toMatchObject({ content: 'generation-2-message-51' });
		expect(chat.pageStates.earlier.status).toBe('loading');

		resolveNewPage({
			chatId: 'chat-1',
			limit: 50,
			...page({
				transcriptViewId: 'generation-2',
				messages: Array.from({ length: 50 }, (_, index) =>
					entry(index + 1, assistant(`generation-2-message-${index + 1}`)),
				),
				lastOrdinal: 100,
				pageOldestOrdinal: 1,
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
			lastOrdinal: 100,
			pageOldestOrdinal: 51,
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
		applyMessages(chat, 'chat-1', 'generation-2', [entry(1, assistant('new generation'))]);

		expect(
			chat.setFromPage(
				'chat-1',
				page({
					transcriptViewId: 'generation-1',
					messages: latestWindow,
					lastOrdinal: 100,
					pageOldestOrdinal: 51,
					hasMore: true,
				}),
				snapshotEpoch,
			),
		).toBe('view-changed');
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
				lastOrdinal: 100,
				pageOldestOrdinal: 1,
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
				lastOrdinal: 100,
				pageOldestOrdinal: 0,
				pageNewestOrdinal: 50,
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
			{ lastOrdinal: 3, pageOldestOrdinal: 1, hasMore: false },
		);

		expect(transcriptCache.get('chat-1')?.messages.map((item) => item.ordinal)).toEqual([2, 3]);

		const result = applyMessages(chat, 'chat-1', 'generation-1', [entry(4, assistant('fourth'))]);

		expect(result).toBe('applied');
		expect(chat.chatMessages.map(contentOf)).toEqual(['first', 'second', 'third', 'fourth']);
		expect(transcriptCache.get('chat-1')?.messages.map((item) => item.ordinal)).toEqual([3, 4]);
	});
});

describe('server notices', () => {
	it('appends immediately for the active chat', () => {
		const chat = new ActiveTranscriptState();
		chat.activateChat('chat-1');

		chat.appendServerNotice('chat-1', 'warning', 'active warning');

		expect(chat.localNotices.map((notice) => notice.content)).toEqual(['active warning']);
	});

	it('retains a background notice and surfaces it exactly once on activation', () => {
		const chat = new ActiveTranscriptState();
		chat.activateChat('chat-1');

		chat.appendServerNotice('chat-2', 'warning', 'background warning');
		expect(chat.localNotices).toEqual([]);

		chat.activateChat('chat-2');
		expect(chat.localNotices.map((notice) => [notice.noticeType, notice.content])).toEqual([
			['warning', 'background warning'],
		]);

		chat.activateChat('chat-1');
		expect(chat.localNotices).toEqual([]);
		chat.activateChat('chat-2');
		expect(chat.localNotices).toEqual([]);
	});

	it('never surfaces a notice in another chat during rapid switching', () => {
		const chat = new ActiveTranscriptState();
		chat.activateChat('chat-1');
		chat.activateChat('chat-2');

		chat.appendServerNotice('chat-1', 'error', 'late failure for chat-1');
		expect(chat.localNotices).toEqual([]);

		chat.activateChat('chat-3');
		expect(chat.localNotices).toEqual([]);

		chat.activateChat('chat-1');
		expect(chat.localNotices.map((notice) => [notice.noticeType, notice.content])).toEqual([
			['error', 'late failure for chat-1'],
		]);
	});

	it('bounds retained notices per background chat to the newest entries', () => {
		const chat = new ActiveTranscriptState();
		chat.activateChat('chat-1');
		for (let index = 0; index < 10; index += 1) {
			chat.appendServerNotice('chat-2', 'warning', `notice-${index}`);
		}

		chat.activateChat('chat-2');

		expect(chat.localNotices.map((notice) => notice.content)).toEqual(
			Array.from({ length: 8 }, (_, index) => `notice-${index + 2}`),
		);
	});

	it('drops retained notices with the chat', () => {
		const chat = new ActiveTranscriptState();
		chat.activateChat('chat-1');
		chat.appendServerNotice('chat-2', 'warning', 'orphaned');

		chat.discardServerNotices('chat-2');
		chat.activateChat('chat-2');

		expect(chat.localNotices).toEqual([]);
	});
});
