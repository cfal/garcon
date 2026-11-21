import { seedTranscript } from '$lib/chat/transcript/__tests__/transcript-fixture.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
	reloadChatFromNative,
	type ChatReloadOptions,
	type ChatReloadPort,
} from '$lib/chat/conversation/reload-chat.js';
import { ChatTranscriptCache } from '$lib/chat/transcript/chat-transcript-cache.svelte.js';
import { ConversationTranscriptOverlayStore } from '$lib/chat/transcript/conversation-transcript-overlay-store.svelte.js';
import { ConversationPanelRegistry } from '../conversation-panel-registry.svelte.js';
import { ConversationLifecycleState } from '../conversation-lifecycle-state.svelte.js';
import { getChatMessages } from '$lib/api/chats.js';
import { AssistantMessage } from '$shared/chat-types';
import type { CompleteChatHistoryResponse } from '$shared/chat-view';
import type { WsRequestProgress } from '$lib/ws/connection.svelte.js';
import { WsRequestError } from '$lib/ws/ws-request-error.js';

vi.mock('$lib/api/chats.js', () => ({
	getChatMessages: vi.fn(),
}));

const TS = '2024-01-01T00:00:00.000Z';
const cleanups: (() => void)[] = [];

function fixture() {
	const cache = new ChatTranscriptCache({ limit: 100 });
	const lifecycle = new ConversationLifecycleState();
	const panels = new ConversationPanelRegistry({
		cache, overlays: new ConversationTranscriptOverlayStore(),
		lifecycle: { forChat: () => lifecycle, remove: () => {} },
		getComposerAnchorSurfaceId: () => 'chat-view:window-main', getSelectedChatId: () => 'chat-1',
	});
	panels.reconcile([{ chatId: 'chat-1', surfaceId: 'chat-view:window-main', windowId: 'window-main',
		presentation: 'window-main', snapshotAdmission: 'admitted' }]);
	cleanups.push(() => { panels.destroy(); cache.flush(); });
	return { panels, chat: panels.panel('chat-view:window-main')!.transcript };
}

function wsWithResponse(response: Record<string, unknown> | Promise<Record<string, unknown>>) {
	const requests: WsRequestProgress[] = [];
	const ws = {
		sendProgressRequest: vi.fn((_message: object, progress: WsRequestProgress) => {
			requests.push(progress);
			return { clientRequestId: 'req-1', response: Promise.resolve(response) };
		}),
		sendMessage: vi.fn(() => true),
	} satisfies ChatReloadPort;
	return Object.assign(ws, { progress: () => requests[0]! });
}

function options(overrides: Partial<ChatReloadOptions> = {}): ChatReloadOptions {
	return { signal: new AbortController().signal, onProgress: vi.fn(), ...overrides };
}

describe('reloadChatFromNative', () => {
	afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });
	beforeEach(() => {
		localStorage.clear();
		vi.mocked(getChatMessages).mockReset();
	});

	it('keeps older capped transcript pages reachable after a correlated reload', async () => {
		const ws = wsWithResponse({
			type: 'chat-reloaded',
			clientRequestId: 'req-1',
			chatId: 'chat-1',
			transcriptViewId: 'generation-2',
			lastOrdinal: 4,
			pageOldestOrdinal: 3,
			pageNewestOrdinal: 4,
			nextBeforeOrdinal: 3,
			hasMore: true,
			messages: [
				{
					ordinal: 3,
					message: { type: 'assistant-message', timestamp: TS, content: 'three' },
				},
				{
					ordinal: 4,
					message: { type: 'assistant-message', timestamp: TS, content: 'four' },
				},
			],
		});
		vi.mocked(getChatMessages).mockResolvedValue({
			historyState: { kind: 'complete' },
			chatId: 'chat-1',
			transcriptViewId: 'generation-2',
			lastOrdinal: 4,
			pageOldestOrdinal: 1,
			pageNewestOrdinal: 2,
			nextBeforeOrdinal: null,
			hasMore: false,
			limit: 50,
			resendCandidates: [],
			messages: [
				{ ordinal: 1, message: new AssistantMessage(TS, 'one') },
				{ ordinal: 2, message: new AssistantMessage(TS, 'two') },
			],
		});
		const { chat, panels } = fixture();

		await expect(reloadChatFromNative(ws, panels, 'chat-1', options())).resolves.toBe('reloaded');

		expect(ws.sendProgressRequest).toHaveBeenCalledWith(
			{ type: 'chat-reload', chatId: 'chat-1' },
			expect.objectContaining({ type: 'chat-reload-progress', idleTimeoutMs: 30_000 }),
		);
		expect(chat.getCursor()).toEqual({ transcriptViewId: 'generation-2', lastOrdinal: 4 });
		expect(chat.hasEarlierMessages).toBe(true);
		expect(chat.nextBeforeOrdinal).toBe(3);
		expect(chat.chatMessages[0]).toBeInstanceOf(AssistantMessage);
		expect(chat.chatMessages.map((message) => (message as AssistantMessage).content)).toEqual([
			'three',
			'four',
		]);
		expect(chat.transcriptCache.get('chat-1')).toMatchObject({
			lastOrdinal: 4,
			nextBeforeOrdinal: 3,
		});

		await expect(chat.loadEarlierPage('chat-1')).resolves.toBe('loaded');

		expect(getChatMessages).toHaveBeenCalledWith({
			chatId: 'chat-1',
			limit: 50,
			beforeOrdinal: 3,
			transcriptViewId: 'generation-2',
		});
		expect(chat.chatMessages.map((message) => (message as AssistantMessage).content)).toEqual([
			'one',
			'two',
			'three',
			'four',
		]);
		expect(chat.hasEarlierMessages).toBe(false);
	});

	it('rejects unexpected reload responses', async () => {
		const ws = wsWithResponse({
			type: 'chat-subscribed',
			clientRequestId: 'req-1',
			chatId: 'chat-1',
			transcriptViewId: 'generation-1',
			mode: 'delta',
			messages: [],
			lastOrdinal: 0,
		});

		await expect(
			reloadChatFromNative(ws, fixture().panels, 'chat-1', options()),
		).rejects.toThrow(
			'Unexpected chat reload response',
		);
	});

	it.each(['generation-2', 'generation-3'])('preserves newer inputs when %s is installed before the reload reply', async viewId => {
		const { chat, panels } = fixture();
		seedTranscript(chat, 'chat-1', 'generation-1', [], {
			lastOrdinal: 0, pageOldestOrdinal: 0, nextBeforeOrdinal: null, hasMore: false,
		});
		const response = Promise.withResolvers<Record<string, unknown>>();
		const reloading = reloadChatFromNative(wsWithResponse(response.promise), panels, 'chat-1', options());
		panels.handleViewReplacement('chat-1');
		expect(chat.setFromPage('chat-1', {
			transcriptViewId: viewId, messages: [{ ordinal: 1, message: new AssistantMessage(TS, 'newer') }],
			lastOrdinal: 1, pageOldestOrdinal: 1, pageNewestOrdinal: 1, nextBeforeOrdinal: null, hasMore: false,
		}, chat.beginSnapshotLoad())).toBe('applied');
		panels.upsertOptimisticInput('chat-1', { chatId: 'chat-1', clientMessageId: 'new-input',
			content: 'new guidance', createdAt: TS, delivery: 'pending', placement: 'live-tail' });
		response.resolve({ type: 'chat-reloaded', clientRequestId: 'req-1', chatId: 'chat-1', transcriptViewId: 'generation-2',
			lastOrdinal: 0, pageOldestOrdinal: 0, pageNewestOrdinal: 0, nextBeforeOrdinal: null, hasMore: false, messages: [] });
		await expect(reloading).resolves.toBe('reloaded');
		expect(chat.getCursor()).toEqual({ transcriptViewId: viewId, lastOrdinal: 1 });
		expect(chat.optimisticUserInputs.map(input => input.clientMessageId)).toEqual(['new-input']);
	});

	it.each(['snapshot-first', 'reply-first', 'snapshot-failure'] as const)(
		'preserves both panels and new guidance across an overlapping reload snapshot (%s)', async completion => {
			const page: CompleteChatHistoryResponse = {
				chatId: 'chat-1', transcriptViewId: 'generation-2', lastOrdinal: 1,
				pageOldestOrdinal: 1, pageNewestOrdinal: 1, nextBeforeOrdinal: null, hasMore: false,
				messages: [{ ordinal: 1, message: new AssistantMessage(TS, 'Native history') }],
				historyState: { kind: 'complete' }, limit: 50, resendCandidates: [],
			};
			vi.mocked(getChatMessages).mockResolvedValue({ ...page, transcriptViewId: 'generation-1',
				messages: [{ ordinal: 1, message: new AssistantMessage(TS, 'Previous history') }] });
			const { chat, panels } = fixture();
			await panels.loadChatSnapshot('chat-1');
			panels.reconcile((['main', 'peer'] as const).map(id => ({ chatId: 'chat-1', surfaceId: `chat-view:window-${id}`,
				windowId: `window-${id}`, presentation: `window-${id}`, snapshotAdmission: 'admitted' } as const)));
			await panels.loadChatSnapshot('chat-1');
			const response = Promise.withResolvers<Record<string, unknown>>();
			const reloading = reloadChatFromNative(wsWithResponse(response.promise), panels, 'chat-1', options());
			const history = Promise.withResolvers<CompleteChatHistoryResponse>();
			vi.mocked(getChatMessages).mockClear().mockReturnValueOnce(history.promise);
			panels.handleViewReplacement('chat-1');
			const loading = panels.loadChatSnapshot('chat-1');
			expect(getChatMessages).toHaveBeenCalledOnce();
			const reply = { ...page, type: 'chat-reloaded', clientRequestId: 'req-1' };
			if (completion === 'snapshot-first') {
				history.resolve(page);
				await expect(loading).resolves.toBe(true);
			} else {
				response.resolve(reply);
				await expect(reloading).resolves.toBe('reloaded');
			}
			expect(panels.applyCommittedBatch({ chatId: 'chat-1', transcriptViewId: 'generation-2',
				messages: [{ ordinal: 2, message: new AssistantMessage(TS, 'New live output') }],
				firstOrdinal: 2, lastOrdinal: 2, resendCandidates: [], noticeRevision: 0,
			}).kind).toBe('applied');
			panels.upsertOptimisticInput('chat-1', { chatId: 'chat-1', clientMessageId: 'new-input',
				content: 'New guidance', createdAt: TS, delivery: 'pending', placement: 'live-tail' });

			if (completion === 'snapshot-first') {
				response.resolve(reply);
				await expect(reloading).resolves.toBe('reloaded');
			} else if (completion === 'snapshot-failure') {
				history.reject(new Error('Obsolete snapshot failed'));
				await expect(loading).rejects.toThrow('Obsolete snapshot failed');
			} else {
				history.resolve(page);
				await expect(loading).resolves.toBe(false);
			}
			expect(panels.panelsForChat('chat-1')).toHaveLength(2);
			for (const panel of panels.panelsForChat('chat-1')) {
				expect(panel.transcript.getCursor()).toEqual({ transcriptViewId: 'generation-2', lastOrdinal: 2 });
				expect(panel.transcript.chatMessages).toEqual([
					expect.objectContaining({ content: 'Native history' }),
					expect.objectContaining({ content: 'New live output' }),
				]);
				expect(panel.transcript.optimisticUserInputs.map(input => input.clientMessageId)).toEqual(['new-input']);
				expect(panel.transcript.isLoadingMessages).toBe(false);
				expect(panel.transcript.loadError).toBeNull();
			}
			expect(chat.transcriptCache.readAppliedCursor('chat-1')).toMatchObject({
				transcriptViewId: 'generation-2', lastOrdinal: 2, stale: false,
			});
			expect(getChatMessages).toHaveBeenCalledOnce();
		},
	);

	it('keeps the current transcript when replacement page metadata is malformed', async () => {
		const ws = wsWithResponse({
			type: 'chat-reloaded',
			clientRequestId: 'req-1',
			chatId: 'chat-1',
			transcriptViewId: 'generation-2',
			lastOrdinal: 2,
			pageOldestOrdinal: 1,
			pageNewestOrdinal: 2,
			nextBeforeOrdinal: null,
			hasMore: false,
			messages: [
				{
					ordinal: 2,
					message: { type: 'assistant-message', timestamp: TS, content: 'replacement' },
				},
			],
		});
		const { chat, panels } = fixture();
		seedTranscript(chat, 'chat-1', 'generation-1', [
			{ ordinal: 1, message: new AssistantMessage(TS, 'current') },
		], {
			lastOrdinal: 1,
			pageOldestOrdinal: 1,
			pageNewestOrdinal: 1,
			nextBeforeOrdinal: null,
			hasMore: false,
		});

		await expect(reloadChatFromNative(ws, panels, 'chat-1', options())).rejects.toThrow(
			'Unexpected chat reload response',
		);
		expect(chat.transcriptViewId).toBe('generation-1');
		expect(chat.chatMessages).toEqual([
			expect.objectContaining({ type: 'assistant-message', content: 'current' }),
		]);
	});

	it('forwards only well-formed progress for the reloading chat', async () => {
		const response = Promise.withResolvers<Record<string, unknown>>();
		const ws = wsWithResponse(response.promise);
		const onProgress = vi.fn();
		const reloading = reloadChatFromNative(
			ws,
			fixture().panels,
			'chat-1',
			options({ onProgress }),
		);

		const progress = ws.progress();
		progress.onProgress({
			type: 'chat-reload-progress',
			clientRequestId: 'req-1',
			chatId: 'chat-1',
			phase: 'reading',
			rows: 1200,
		});
		progress.onProgress({
			type: 'chat-reload-progress',
			clientRequestId: 'req-1',
			chatId: 'chat-2',
			phase: 'saving',
			rows: 5,
		});
		progress.onProgress({
			type: 'chat-reload-progress',
			clientRequestId: 'req-1',
			chatId: 'chat-1',
			phase: 'unknown',
			rows: 5,
		});
		response.reject(new Error('stop'));

		await expect(reloading).rejects.toThrow('stop');
		expect(onProgress).toHaveBeenCalledExactlyOnceWith({ phase: 'reading', rows: 1200 });
	});

	it('asks the server to cancel and reports a cancelled reload without an error', async () => {
		const response = Promise.withResolvers<Record<string, unknown>>();
		const ws = wsWithResponse(response.promise);
		const cancellation = new AbortController();
		const { chat, panels } = fixture();
		const reloading = reloadChatFromNative(
			ws,
			panels,
			'chat-1',
			options({ signal: cancellation.signal }),
		);

		cancellation.abort();
		expect(ws.sendMessage).toHaveBeenCalledExactlyOnceWith(
			expect.objectContaining({
				type: 'chat-reload-cancel',
				chatId: 'chat-1',
				reloadRequestId: 'req-1',
			}),
		);
		response.reject(new WsRequestError('REQUEST_CANCELLED', 'Reload cancelled', true));

		await expect(reloading).resolves.toBe('cancelled');
		expect(chat.transcriptViewId).toBe('');
	});

	it('applies a reload that completed despite a late cancellation', async () => {
		const response = Promise.withResolvers<Record<string, unknown>>();
		const ws = wsWithResponse(response.promise);
		const cancellation = new AbortController();
		const { chat, panels } = fixture();
		const reloading = reloadChatFromNative(
			ws,
			panels,
			'chat-1',
			options({ signal: cancellation.signal }),
		);

		cancellation.abort();
		response.resolve({
			type: 'chat-reloaded',
			clientRequestId: 'req-1',
			chatId: 'chat-1',
			transcriptViewId: 'generation-2',
			lastOrdinal: 1,
			pageOldestOrdinal: 1,
			pageNewestOrdinal: 1,
			nextBeforeOrdinal: null,
			hasMore: false,
			messages: [
				{ ordinal: 1, message: { type: 'assistant-message', timestamp: TS, content: 'native' } },
			],
		});

		await expect(reloading).resolves.toBe('reloaded');
		expect(chat.transcriptViewId).toBe('generation-2');
	});
});
