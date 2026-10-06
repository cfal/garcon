import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AssistantMessage } from '$shared/chat-types';
import { getChatMessages } from '$lib/api/chats.js';
import { ChatTranscriptCache } from '$lib/chat/transcript/chat-transcript-cache.svelte.js';
import { ConversationTranscriptOverlayStore } from '$lib/chat/transcript/conversation-transcript-overlay-store.svelte.js';
import { ConversationLifecycleState } from '../conversation-lifecycle-state.svelte.js';
import {
	ConversationPanelRegistry,
	type ConversationPanelDescriptor,
} from '../conversation-panel-registry.svelte.js';

vi.mock('$lib/api/chats.js', () => ({ getChatMessages: vi.fn() }));

const descriptor = {
	surfaceId: 'chat-view:window-left',
	chatId: 'chat-1',
	presentation: 'window-left',
	windowId: 'window-left',
	snapshotAdmission: 'admitted',
} satisfies ConversationPanelDescriptor;

function message(ordinal: number) {
	return { ordinal, message: new AssistantMessage('2026-01-01T00:00:00.000Z', `row-${ordinal}`) };
}

function snapshot(transcriptViewId: string): Awaited<ReturnType<typeof getChatMessages>> {
	return {
		chatId: 'chat-1',
		limit: 50,
		historyState: { kind: 'complete' },
		transcriptViewId,
		messages: [message(1)],
		lastOrdinal: 1,
		pageOldestOrdinal: 1,
		pageNewestOrdinal: 1,
		nextBeforeOrdinal: null,
		hasMore: false,
		resendCandidates: [],
	};
}

describe('fullscreen retained panel recovery', () => {
	let cache: ChatTranscriptCache;
	let panels: ConversationPanelRegistry;

	beforeEach(() => {
		localStorage.clear();
		vi.mocked(getChatMessages).mockReset();
		cache = new ChatTranscriptCache({ limit: 100, persistenceDelayMs: 60_000 });
		cache.replace('chat-1', 'view-1', [message(1)], 1, null);
		panels = new ConversationPanelRegistry({
			cache,
			overlays: new ConversationTranscriptOverlayStore(),
			lifecycle: { forChat: () => new ConversationLifecycleState(), remove: vi.fn() },
			getComposerAnchorSurfaceId: () => descriptor.surfaceId,
			getSelectedChatId: () => descriptor.chatId,
		});
		panels.reconcile([descriptor]);
		panels.panel(descriptor.surfaceId)!.attachPresentation({
			getScrollContainer: () => null,
			getViewport: () => null,
			getQueueContainer: () => undefined,
			captureRestoreTarget: () => ({ kind: 'end' }),
			closeTransients: vi.fn(),
			prepareForHide: vi.fn(),
		});
	});

	afterEach(() => {
		panels.destroy();
		cache.flush();
	});

	function hide(): void {
		panels.prepareForReconcile([], [descriptor]);
		panels.reconcile([], [descriptor]);
	}

	it('fences a pre-replacement snapshot during a rapid hide/reveal', async () => {
		let releaseOld!: (value: Awaited<ReturnType<typeof getChatMessages>>) => void;
		vi.mocked(getChatMessages)
			.mockReturnValueOnce(
				new Promise((resolve) => {
					releaseOld = resolve;
				}),
			)
			.mockResolvedValue(snapshot('view-2'));
		const original = panels.panel(descriptor.surfaceId)!;
		const oldLoad = panels.loadChatSnapshot('chat-1', { minimumLimit: 50 });
		expect(getChatMessages).toHaveBeenCalledOnce();
		hide();
		panels.handleViewReplacement('chat-1');
		panels.reconcile([descriptor]);
		releaseOld(snapshot('view-1'));
		await oldLoad;
		await vi.waitFor(() => expect(original.transcript.transcriptViewId).toBe('view-2'));
		expect(cache.readAppliedCursor('chat-1')?.transcriptViewId).toBe('view-2');
		expect(getChatMessages).toHaveBeenCalledTimes(2);
		expect(panels.panel(descriptor.surfaceId)).toBe(original);
	});

	it('resumes without a snapshot after reconnect proves continuity', async () => {
		vi.mocked(getChatMessages).mockResolvedValue(snapshot('view-1'));
		panels.markChatStale('chat-1');
		const token = panels.beginReconnectReplay('chat-1', 'view-1');
		expect(
			panels.applyReconnectReplayPage(token, 'chat-1', {
				transcriptViewId: 'view-1',
				messages: [message(2)],
				firstOrdinal: 2,
				lastOrdinal: 2,
				resendCandidates: [],
				noticeRevision: 0,
			}),
		).toBe('applied');
		expect(panels.finishReconnectReplay(token, 'chat-1', 2)).toBe('applied');
		hide();
		panels.reconcile([descriptor]);
		await Promise.resolve();
		expect(cache.readAppliedCursor('chat-1')?.stale).toBe(false);
		expect(getChatMessages).not.toHaveBeenCalled();
	});

	it('ignores failure of a superseded snapshot after replacement recovery', async () => {
		let rejectOld!: (error: Error) => void;
		vi.mocked(getChatMessages)
			.mockReturnValueOnce(
				new Promise((_resolve, reject) => {
					rejectOld = reject;
				}),
			)
			.mockResolvedValue(snapshot('view-2'));
		const oldLoad = panels.loadChatSnapshot('chat-1');
		hide();
		panels.handleViewReplacement('chat-1');
		panels.reconcile([descriptor]);
		await vi.waitFor(() =>
			expect(cache.readAppliedCursor('chat-1')?.transcriptViewId).toBe('view-2'),
		);
		rejectOld(new Error('Superseded snapshot failed'));
		await expect(oldLoad).resolves.toBe(false);
		expect(cache.readAppliedCursor('chat-1')?.stale).toBe(false);
	});

	it('does not let an older replay validate newer recovery debt', () => {
		panels.markChatStale('chat-1');
		const token = panels.beginReconnectReplay('chat-1', 'view-1');
		panels.markChatStale('chat-1');
		expect(panels.finishReconnectReplay(token, 'chat-1', 1)).toBe('gap-detected');
		expect(cache.readAppliedCursor('chat-1')?.stale).toBe(true);
	});

	it.each([
		['view-1', true],
		['view-1', false],
		['view-2', true],
		['view-2', false],
	])('restores a recovered %s reader with visible=%s', async (viewId, remainsVisible) => {
		const duplicate = {
			...descriptor,
			surfaceId: 'chat-view:window-right',
			presentation: 'window-right',
			windowId: 'window-right',
		} satisfies ConversationPanelDescriptor;
		panels.reconcile([descriptor, duplicate]);
		const reader = panels.panel(descriptor.surfaceId)!;
		await reader.restore(null);
		const target = {
			kind: 'row',
			transcriptViewId: 'view-1',
			ordinal: 1,
			viewportOffset: 4,
		} as const;
		reader.attachPresentation({
			getScrollContainer: () => null,
			getViewport: () => null,
			getQueueContainer: () => undefined,
			captureRestoreTarget: () => target,
			closeTransients: vi.fn(),
			prepareForHide: vi.fn(),
		});
		reader.scroll.setPinnedToBottom(false);
		if (!remainsVisible) {
			panels.prepareForReconcile([duplicate], [descriptor]);
			panels.reconcile([duplicate], [descriptor]);
		}
		const restoreEnd = vi.spyOn(reader.scroll, 'prepareInitialBottomRestore');
		vi.mocked(getChatMessages).mockResolvedValue(snapshot(viewId));
		panels.markChatStale('chat-1');
		await expect(panels.loadChatSnapshot('chat-1')).resolves.toBe(true);
		expect(reader.transcript.transcriptViewId).toBe(viewId);
		expect(reader.scroll.isPinnedToBottom).toBe(viewId === 'view-2');
		expect(restoreEnd).toHaveBeenCalledTimes(viewId === 'view-2' && remainsVisible ? 1 : 0);
		if (!remainsVisible) {
			expect(reader.captureRestoreTarget()).toEqual(viewId === 'view-2' ? { kind: 'end' } : target);
		}
		panels.reconcile([descriptor, duplicate]);
		expect(panels.panel(descriptor.surfaceId)).toBe(reader);
		expect(restoreEnd).toHaveBeenCalledTimes(viewId === 'view-2' ? 1 : 0);
		expect(getChatMessages).toHaveBeenCalledOnce();
	});

	it('resets a hidden reader when a fresh cache reveals a replaced view', async () => {
		const reader = panels.panel(descriptor.surfaceId)!;
		await reader.restore(null);
		reader.scroll.setPinnedToBottom(false);
		hide();
		cache.replace('chat-1', 'view-2', [message(1)], 1, null);
		const restoreEnd = vi.spyOn(reader.scroll, 'prepareInitialBottomRestore');
		panels.reconcile([descriptor]);
		expect(reader.transcript.transcriptViewId).toBe('view-2');
		expect(reader.scroll.isPinnedToBottom).toBe(true);
		expect(restoreEnd).toHaveBeenCalledOnce();
		expect(reader.captureRestoreTarget()).toEqual({ kind: 'end' });
		expect(getChatMessages).not.toHaveBeenCalled();
	});

	it('resets a duplicate reader registered during replacement snapshot recovery', async () => {
		let release!: (value: Awaited<ReturnType<typeof getChatMessages>>) => void;
		vi.mocked(getChatMessages).mockReturnValueOnce(
			new Promise((resolve) => {
				release = resolve;
			}),
		);
		const recovery = panels.loadChatSnapshot('chat-1');
		const duplicate = {
			...descriptor,
			surfaceId: 'chat-view:window-right',
			presentation: 'window-right',
			windowId: 'window-right',
		} satisfies ConversationPanelDescriptor;
		panels.reconcile([descriptor, duplicate]);
		const reader = panels.panel(duplicate.surfaceId)!;
		await reader.restore(null);
		reader.attachPresentation({
			getScrollContainer: () => null,
			getViewport: () => null,
			getQueueContainer: () => undefined,
			captureRestoreTarget: () => ({
				kind: 'row',
				transcriptViewId: 'view-1',
				ordinal: 1,
				viewportOffset: 4,
			}),
			closeTransients: vi.fn(),
			prepareForHide: vi.fn(),
		});
		reader.scroll.setPinnedToBottom(false);
		panels.prepareForReconcile([descriptor], [duplicate]);
		panels.reconcile([descriptor], [duplicate]);
		release(snapshot('view-2'));
		await expect(recovery).resolves.toBe(true);
		expect(reader.transcript.transcriptViewId).toBe('view-2');
		expect(reader.scroll.isPinnedToBottom).toBe(true);
		expect(reader.captureRestoreTarget()).toEqual({ kind: 'end' });
		const restoreEnd = vi.spyOn(reader.scroll, 'prepareInitialBottomRestore');
		panels.reconcile([descriptor, duplicate]);
		expect(restoreEnd).toHaveBeenCalledOnce();
		expect(panels.panel(duplicate.surfaceId)).toBe(reader);
		expect(getChatMessages).toHaveBeenCalledOnce();
	});
});
