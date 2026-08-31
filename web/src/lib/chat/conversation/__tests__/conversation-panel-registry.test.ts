import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AssistantMessage } from '$shared/chat-types';
import type { ResendCandidate, TranscriptMessage } from '$shared/chat-view';
import type { ChatLoadMessagesOptions } from '$lib/chat/transcript/active-transcript-state.svelte.js';
import { ChatTranscriptCache } from '$lib/chat/transcript/chat-transcript-cache.svelte.js';
import { ConversationTranscriptOverlayStore } from '$lib/chat/transcript/conversation-transcript-overlay-store.svelte.js';
import { ConversationLifecycleState } from '../conversation-lifecycle-state.svelte.js';
import {
	ConversationPanelRegistry,
	type ConversationPanelPresentationPort,
} from '../conversation-panel-registry.svelte.js';
import { CurrentConversationPanelTranscript } from '../current-conversation-panel-transcript.js';
import type { VisibleChatPresentation } from '$lib/workspace/visible-presentations.js';

function message(ordinal: number): TranscriptMessage {
	return {
		ordinal,
		message: new AssistantMessage('2026-08-30T00:00:00.000Z', `message-${ordinal}`),
	};
}

function candidate(ordinal: number): ResendCandidate {
	return { ordinal, content: `candidate-${ordinal}`, attachmentNames: [] };
}

function presentation(
	surfaceId: `chat-view:window-${string}`,
	chatId: string,
	isCurrent = false,
): VisibleChatPresentation {
	const windowId = surfaceId.slice('chat-view:'.length) as `window-${string}`;
	return { surfaceId, chatId, presentation: windowId, windowId, isCurrent };
}

function fixture(options: {
	loadTranscriptSnapshot?: (
		transcript: import('$lib/chat/transcript/active-transcript-state.svelte.js').ActiveTranscriptState,
		chatId: string,
		options: ChatLoadMessagesOptions,
	) => Promise<void>;
} = {}) {
	const cache = new ChatTranscriptCache({ limit: 100, persistenceDelayMs: 60_000 });
	const overlays = new ConversationTranscriptOverlayStore();
	const lifecycles = new Map<string, ConversationLifecycleState>();
	const lifecycle = {
		forChat(chatId: string) {
			const existing = lifecycles.get(chatId);
			if (existing) return existing;
			const created = new ConversationLifecycleState();
			created.setCurrentChatId(chatId);
			lifecycles.set(chatId, created);
			return created;
		},
		remove(chatId: string) {
			lifecycles.delete(chatId);
		},
	};
	const registry = new ConversationPanelRegistry({
		cache,
		overlays,
		lifecycle,
		loadTranscriptSnapshot: options.loadTranscriptSnapshot,
	});
	return { cache, overlays, lifecycles, registry };
}

function seed(cache: ChatTranscriptCache, chatId = 'chat-1'): void {
	cache.replace(chatId, 'view-1', [message(1)], 1, null);
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((resolvePromise) => {
		resolve = resolvePromise;
	});
	return { promise, resolve };
}

function port(target: ConversationPanelPresentationPort['captureRestoreTarget'] extends () => infer T ? T : never): ConversationPanelPresentationPort {
	return {
		getScrollContainer: () => null,
		getViewport: () => null,
		getQueueContainer: () => undefined,
		captureRestoreTarget: () => target,
		closeTransients: vi.fn(),
	};
}

describe('ConversationPanelRegistry', () => {
	beforeEach(() => {
		localStorage.clear();
	});

	it('commits one cache batch and fans it out to duplicate-chat surfaces', () => {
		const { cache, registry } = fixture();
		seed(cache);
		registry.reconcile([
			presentation('chat-view:window-left', 'chat-1', true),
			presentation('chat-view:window-right', 'chat-1'),
		]);
		const applyMessages = vi.spyOn(cache, 'applyMessages');

		const result = registry.applyCommittedBatch({
			chatId: 'chat-1',
			transcriptViewId: 'view-1',
			messages: [message(2)],
			firstOrdinal: 2,
			lastOrdinal: 2,
			resendCandidates: [],
			noticeRevision: 0,
		});

		expect(result).toEqual({ kind: 'applied', localRecoverySurfaceIds: [] });
		expect(applyMessages).toHaveBeenCalledOnce();
		expect(registry.panel('chat-view:window-left')?.transcript.entries.map((entry) => entry.ordinal)).toEqual([1, 2]);
		expect(registry.panel('chat-view:window-right')?.transcript.entries.map((entry) => entry.ordinal)).toEqual([1, 2]);
		cache.flush();
	});

	it('holds live shared commits behind a fixed reconnect replay watermark', () => {
		const { cache, registry } = fixture();
		seed(cache);
		registry.reconcile([
			presentation('chat-view:window-left', 'chat-1', true),
			presentation('chat-view:window-right', 'chat-1'),
		]);
		const applyMessages = vi.spyOn(cache, 'applyMessages');
		const replayToken = registry.beginReconnectReplay('chat-1', 'view-1');

		expect(registry.applyReconnectReplayPage(replayToken, 'chat-1', {
			transcriptViewId: 'view-1',
			messages: [message(2)],
			firstOrdinal: 2,
			lastOrdinal: 2,
			resendCandidates: [],
			noticeRevision: 0,
		})).toBe('applied');
		expect(registry.applyCommittedBatch({
			chatId: 'chat-1',
			transcriptViewId: 'view-1',
			messages: [message(4)],
			firstOrdinal: 4,
			lastOrdinal: 4,
			resendCandidates: [],
			noticeRevision: 0,
		})).toEqual({ kind: 'applied', localRecoverySurfaceIds: [] });

		expect(cache.readAppliedCursor('chat-1')?.lastOrdinal).toBe(2);
		expect(registry.panel('chat-view:window-left')?.transcript.entries.map((entry) => entry.ordinal))
			.toEqual([1, 2]);
		expect(registry.applyReconnectReplayPage(replayToken, 'chat-1', {
			transcriptViewId: 'view-1',
			messages: [message(3)],
			firstOrdinal: 3,
			lastOrdinal: 3,
			resendCandidates: [],
			noticeRevision: 0,
		})).toBe('applied');
		expect(registry.finishReconnectReplay(replayToken, 'chat-1')).toBe('applied');

		expect(applyMessages).toHaveBeenCalledTimes(3);
		expect(cache.readAppliedCursor('chat-1')?.lastOrdinal).toBe(4);
		for (const surfaceId of ['chat-view:window-left', 'chat-view:window-right'] as const) {
			expect(registry.panel(surfaceId)?.transcript.entries.map((entry) => entry.ordinal))
				.toEqual([1, 2, 3, 4]);
		}
		cache.flush();
	});

	it('keeps duplicate surfaces independent while sharing lifecycle identity', () => {
		const { cache, registry } = fixture();
		seed(cache);
		registry.reconcile([
			presentation('chat-view:window-left', 'chat-1', true),
			presentation('chat-view:window-right', 'chat-1'),
		]);
		const left = registry.panel('chat-view:window-left');
		const right = registry.panel('chat-view:window-right');

		left?.scroll.setPinnedToBottom(false);

		expect(left?.scroll.isPinnedToBottom).toBe(false);
		expect(right?.scroll.isPinnedToBottom).toBe(true);
		expect(left?.lifecycle).toBe(right?.lifecycle);
		cache.flush();
	});

	it('loads one snapshot and hydrates every current duplicate-chat surface', async () => {
		const { cache, registry } = fixture();
		seed(cache);
		registry.reconcile([
			presentation('chat-view:window-left', 'chat-1', true),
			presentation('chat-view:window-right', 'chat-1'),
		]);
		const left = registry.panel('chat-view:window-left');
		const right = registry.panel('chat-view:window-right');
		if (!left || !right) throw new Error('Expected duplicate panels');
		const loadMessages = vi.spyOn(left.transcript, 'loadMessages').mockImplementation(async () => {
			cache.replace('chat-1', 'view-2', [message(1), message(2)], 2, null);
			left.transcript.activateChat('chat-1');
			return left.transcript.chatMessages;
		});

		await expect(registry.loadChatSnapshot('chat-1')).resolves.toBe(true);

		expect(loadMessages).toHaveBeenCalledOnce();
		expect(left.transcript.transcriptViewId).toBe('view-2');
		expect(right.transcript.transcriptViewId).toBe('view-2');
		expect(right.transcript.entries.map((item) => item.ordinal)).toEqual([1, 2]);
		cache.flush();
	});

	it('shares one initial snapshot request across duplicate-chat surfaces', async () => {
		const loadTranscriptSnapshot = vi.fn(async (transcript, chatId: string) => {
			transcript.transcriptCache.replace(chatId, 'view-1', [message(1)], 1, null);
			transcript.installCachedSnapshot(chatId);
		});
		const { cache, registry } = fixture({ loadTranscriptSnapshot });

		registry.reconcile([
			presentation('chat-view:window-left', 'chat-1', true),
			presentation('chat-view:window-right', 'chat-1'),
		]);

		await vi.waitFor(() => {
			expect(loadTranscriptSnapshot).toHaveBeenCalledOnce();
			expect(registry.panel('chat-view:window-left')?.transcript.entries).toHaveLength(1);
			expect(registry.panel('chat-view:window-right')?.transcript.entries).toHaveLength(1);
		});
		registry.destroy();
		cache.flush();
	});

	it('publishes snapshot resend candidates without cache hydration clearing them', async () => {
		const loadTranscriptSnapshot = vi.fn(async (transcript, chatId: string) => {
			const epoch = transcript.beginSnapshotLoad();
			transcript.setFromPage(chatId, {
				transcriptViewId: 'view-1',
				messages: [message(1)],
				lastOrdinal: 1,
				pageOldestOrdinal: 1,
				pageNewestOrdinal: 1,
				nextBeforeOrdinal: null,
				hasMore: false,
				resendCandidates: [candidate(1)],
			}, epoch);
		});
		const { cache, registry } = fixture({ loadTranscriptSnapshot });

		registry.reconcile([
			presentation('chat-view:window-left', 'chat-1', true),
			presentation('chat-view:window-right', 'chat-1'),
		]);

		await vi.waitFor(() => {
			expect(loadTranscriptSnapshot).toHaveBeenCalledOnce();
			expect(registry.overlayFor('chat-1')?.resendCandidates).toEqual([candidate(1)]);
			expect(registry.panel('chat-view:window-left')?.transcript.resendCandidates).toEqual([
				candidate(1),
			]);
			expect(registry.panel('chat-view:window-right')?.transcript.resendCandidates).toEqual([
				candidate(1),
			]);
		});
		registry.destroy();
		cache.flush();
	});

	it('shares selected-chat revalidation with duplicate-panel restoration', async () => {
		const loading = deferred<void>();
		const loadTranscriptSnapshot = vi.fn(
			async (transcript, chatId: string, _options: ChatLoadMessagesOptions) => {
				await loading.promise;
				transcript.transcriptCache.replace(chatId, 'view-2', [message(2)], 2, null);
				transcript.installCachedSnapshot(chatId);
			},
		);
		const { cache, registry } = fixture({ loadTranscriptSnapshot });
		cache.replace(
			'chat-1',
			'view-1',
			Array.from({ length: 100 }, (_, index) => message(index + 1)),
			100,
			null,
		);
		cache.markStale('chat-1');
		registry.reconcile([
			presentation('chat-view:window-left', 'chat-1', true),
			presentation('chat-view:window-right', 'chat-1'),
		]);
		const selected = new CurrentConversationPanelTranscript({
			panels: registry,
			getComposerAnchorSurfaceId: () => 'chat-view:window-left',
			getSelectedChatId: () => 'chat-1',
		});
		const selectedLoad = selected.loadMessages('chat-1', {
			minimumLimit: 100,
			purpose: 'activation',
		});

		await vi.waitFor(() => expect(loadTranscriptSnapshot).toHaveBeenCalledOnce());
		expect(loadTranscriptSnapshot.mock.calls[0]?.[2]).toEqual({ minimumLimit: 100 });
		loading.resolve();
		await expect(selectedLoad).resolves.toHaveLength(1);
		expect(loadTranscriptSnapshot).toHaveBeenCalledTimes(2);
		expect(loadTranscriptSnapshot.mock.calls[1]?.[2]).toEqual({
			minimumLimit: 100,
			purpose: 'activation',
		});

		expect(registry.panel('chat-view:window-left')?.transcript.transcriptViewId).toBe('view-2');
		expect(registry.panel('chat-view:window-right')?.transcript.transcriptViewId).toBe('view-2');
		registry.destroy();
		cache.flush();
	});

	it('retains rendered rows until a replacement snapshot installs atomically', async () => {
		const replacement = deferred<void>();
		const loadTranscriptSnapshot = vi.fn(async (transcript, chatId: string) => {
			await replacement.promise;
			transcript.transcriptCache.replace(chatId, 'view-2', [message(2)], 2, null);
			transcript.installCachedSnapshot(chatId);
		});
		const { cache, registry } = fixture({ loadTranscriptSnapshot });
		seed(cache);
		registry.reconcile([presentation('chat-view:window-left', 'chat-1', true)]);
		const panel = registry.panel('chat-view:window-left');
		if (!panel) throw new Error('Expected panel');
		registry.handleViewReplacement('chat-1');
		const loading = registry.loadChatSnapshot('chat-1');

		expect(cache.readAppliedCursor('chat-1')?.stale).toBe(true);
		expect(panel.transcript.entries.map((entry) => entry.ordinal)).toEqual([1]);

		replacement.resolve();
		await expect(loading).resolves.toBe(true);
		expect(panel.transcript.transcriptViewId).toBe('view-2');
		expect(panel.transcript.entries.map((entry) => entry.ordinal)).toEqual([2]);
		registry.destroy();
		cache.flush();
	});

	it('preserves an expanded duplicate surface while installing a shared latest snapshot', async () => {
		const { cache, registry } = fixture();
		cache.replace(
			'chat-1',
			'view-1',
			Array.from({ length: 100 }, (_, index) => message(index + 101)),
			200,
			101,
		);
		registry.reconcile([
			presentation('chat-view:window-left', 'chat-1', true),
			presentation('chat-view:window-right', 'chat-1'),
		]);
		const left = registry.panel('chat-view:window-left');
		const right = registry.panel('chat-view:window-right');
		if (!left || !right) throw new Error('Expected duplicate panels');
		const earlierWindow = Array.from({ length: 50 }, (_, index) => message(index + 1));
		right.transcript.entries = earlierWindow;
		right.transcript.transcriptViewId = 'view-1';
		right.transcript.lastOrdinal = 200;
		right.transcript.loadedThroughOrdinal = 50;
		right.transcript.nextBeforeOrdinal = null;
		right.transcript.hasEarlierMessages = false;
		right.transcript.hasLaterMessages = true;
		right.transcript.visibleMessageCount = 37;
		right.transcript.isUserScrolledUp = true;
		right.scroll.setPinnedToBottom(false);
		const preservedEntries = right.transcript.entries;
		vi.spyOn(left.transcript, 'loadMessages').mockImplementation(async () => {
			cache.replace(
				'chat-1',
				'view-1',
				Array.from({ length: 100 }, (_, index) => message(index + 102)),
				201,
				102,
			);
			left.transcript.installCachedSnapshot('chat-1');
			return left.transcript.chatMessages;
		});

		await expect(registry.loadChatSnapshot('chat-1')).resolves.toBe(true);

		expect(right.transcript.entries).toBe(preservedEntries);
		expect(right.transcript.entries.map((item) => item.ordinal)).toEqual(
			Array.from({ length: 50 }, (_, index) => index + 1),
		);
		expect(right.transcript.visibleMessageCount).toBe(37);
		expect(right.transcript.hasLaterMessages).toBe(true);
		expect(right.transcript.isUserScrolledUp).toBe(true);
		expect(right.scroll.isPinnedToBottom).toBe(false);
		cache.flush();
	});

	it('projects selection onto a mounted surface without resetting either duplicate transcript', () => {
		const { cache, registry } = fixture();
		seed(cache);
		registry.reconcile([
			presentation('chat-view:window-left', 'chat-1', true),
			presentation('chat-view:window-right', 'chat-1'),
		]);
		const left = registry.panel('chat-view:window-left');
		const right = registry.panel('chat-view:window-right');
		if (!left || !right) throw new Error('Expected duplicate panels');
		const leftEntries = [message(1)];
		const rightEntries = Array.from({ length: 150 }, (_, index) => message(index + 1));
		left.transcript.entries = leftEntries;
		right.transcript.entries = rightEntries;
		right.transcript.visibleMessageCount = 121;
		right.transcript.hasLaterMessages = true;
		right.transcript.isUserScrolledUp = true;
		right.scroll.setPinnedToBottom(false);
		const preservedLeftEntries = left.transcript.entries;
		const preservedRightEntries = right.transcript.entries;
		const selected = new CurrentConversationPanelTranscript({
			panels: registry,
			getComposerAnchorSurfaceId: () => 'chat-view:window-right',
			getSelectedChatId: () => 'chat-1',
		});

		expect(selected.hasMountedPresentation('chat-1')).toBe(true);
		expect(selected.activateChat('chat-1')).toBeNull();

		expect(left.transcript.entries).toBe(preservedLeftEntries);
		expect(right.transcript.entries).toBe(preservedRightEntries);
		expect(right.transcript.visibleMessageCount).toBe(121);
		expect(right.transcript.hasLaterMessages).toBe(true);
		expect(right.transcript.isUserScrolledUp).toBe(true);
		expect(right.scroll.isPinnedToBottom).toBe(false);
		cache.flush();
	});

	it('recognizes a rendered target during the pointerdown-to-anchor mismatch', () => {
		const { cache, registry } = fixture();
		seed(cache, 'chat-1');
		seed(cache, 'chat-2');
		registry.reconcile([
			presentation('chat-view:window-left', 'chat-1', true),
			presentation('chat-view:window-right', 'chat-2'),
		]);
		const selected = new CurrentConversationPanelTranscript({
			panels: registry,
			getComposerAnchorSurfaceId: () => 'chat-view:window-left',
			getSelectedChatId: () => 'chat-2',
		});

		expect(selected.hasMountedPresentation('chat-2')).toBe(true);
		expect(selected.activateChat('chat-2')).toEqual({ count: 1, stale: false });
		expect(registry.panel('chat-view:window-right')?.transcript.entries).toHaveLength(1);
		cache.flush();
	});

	it('uses generation-checked presentation disposal and captures the current port', () => {
		const { cache, registry } = fixture();
		seed(cache);
		registry.reconcile([presentation('chat-view:window-left', 'chat-1', true)]);
		const panel = registry.panel('chat-view:window-left');
		if (!panel) throw new Error('Expected panel');
		const oldPort = port({ kind: 'end' });
		const currentTarget = {
			kind: 'row' as const,
			transcriptViewId: 'view-1',
			ordinal: 1,
			viewportOffset: 12,
		};
		const disposeOld = panel.attachPresentation(oldPort);
		panel.attachPresentation(port(currentTarget));

		disposeOld();

		expect(panel.prepareForHide()).toEqual(currentTarget);
		expect(oldPort.closeTransients).not.toHaveBeenCalled();
		cache.flush();
	});

	it('captures a panel target before presentation teardown and consumes it on restore', () => {
		const { cache, registry } = fixture();
		seed(cache);
		const visible = [presentation('chat-view:window-left', 'chat-1', true)];
		registry.reconcile(visible);
		const panel = registry.panel('chat-view:window-left');
		if (!panel) throw new Error('Expected panel');
		const target = {
			kind: 'row' as const,
			transcriptViewId: 'view-1',
			ordinal: 1,
			viewportOffset: -3,
		};
		const detach = panel.attachPresentation(port(target));

		registry.prepareForReconcile([]);
		detach();
		registry.reconcile([]);
		registry.reconcile(visible);

		expect(registry.panel('chat-view:window-left')?.prepareForHide()).toEqual(target);
		cache.flush();
	});

	it('restores a detached row at its captured viewport offset', async () => {
		const { cache, registry } = fixture();
		seed(cache);
		registry.reconcile([presentation('chat-view:window-left', 'chat-1', true)]);
		const panel = registry.panel('chat-view:window-left');
		if (!panel) throw new Error('Expected panel');
		const jump = vi.spyOn(panel.scroll, 'jumpToMessageRow').mockResolvedValue('completed');
		panel.attachPresentation(port({ kind: 'end' }));

		await panel.restore({
			kind: 'row',
			transcriptViewId: 'view-1',
			ordinal: 1,
			viewportOffset: -3,
		});

		expect(jump).toHaveBeenCalledWith(
			{
				chatId: 'chat-1',
				transcriptViewId: 'view-1',
				rowId: 'view-1:1',
			},
			{ viewportOffset: -3 },
		);
		cache.flush();
	});

	it('defers a detached row restore until its presentation attaches', async () => {
		const { cache, registry } = fixture();
		seed(cache);
		registry.reconcile([presentation('chat-view:window-left', 'chat-1', true)]);
		const panel = registry.panel('chat-view:window-left');
		if (!panel) throw new Error('Expected panel');
		const jump = vi.spyOn(panel.scroll, 'jumpToMessageRow').mockResolvedValue('completed');

		await panel.restore({
			kind: 'row',
			transcriptViewId: 'view-1',
			ordinal: 1,
			viewportOffset: -3,
		});
		expect(jump).not.toHaveBeenCalled();

		panel.attachPresentation(port({ kind: 'end' }));
		await vi.waitFor(() => expect(jump).toHaveBeenCalledOnce());
		expect(jump).toHaveBeenCalledWith(
			{
				chatId: 'chat-1',
				transcriptViewId: 'view-1',
				rowId: 'view-1:1',
			},
			{ viewportOffset: -3 },
		);
		cache.flush();
	});

	it('retries a pending restore when the attached viewport becomes ready', async () => {
		const { cache, registry } = fixture();
		seed(cache);
		registry.reconcile([presentation('chat-view:window-left', 'chat-1', true)]);
		const panel = registry.panel('chat-view:window-left');
		if (!panel) throw new Error('Expected panel');
		const firstJump = deferred<'unavailable'>();
		const jump = vi
			.spyOn(panel.scroll, 'jumpToMessageRow')
			.mockImplementationOnce(() => firstJump.promise)
			.mockResolvedValueOnce('completed');

		await panel.restore({
			kind: 'row',
			transcriptViewId: 'view-1',
			ordinal: 1,
			viewportOffset: -3,
		});
		panel.attachPresentation(port({ kind: 'end' }));
		await vi.waitFor(() => expect(jump).toHaveBeenCalledOnce());

		panel.resumePendingRestore();
		firstJump.resolve('unavailable');
		await vi.waitFor(() => expect(jump).toHaveBeenCalledTimes(2));
		cache.flush();
	});

	it('drops detached restore targets after their surface is permanently removed', async () => {
		const { cache, registry } = fixture();
		seed(cache);
		const visible = [presentation('chat-view:window-left', 'chat-1', true)];
		registry.reconcile(visible);
		const first = registry.panel('chat-view:window-left');
		if (!first) throw new Error('Expected panel');
		first.attachPresentation(port({
			kind: 'row',
			transcriptViewId: 'view-1',
			ordinal: 1,
			viewportOffset: -3,
		}));

		registry.prepareForReconcile([]);
		registry.reconcile([]);
		registry.pruneRemovedSurfaces(new Set());
		registry.reconcile(visible);
		const restored = registry.panel('chat-view:window-left');
		if (!restored) throw new Error('Expected restored panel');
		const jump = vi.spyOn(restored.scroll, 'jumpToMessageRow').mockResolvedValue('completed');
		restored.attachPresentation(port({ kind: 'end' }));
		await Promise.resolve();

		expect(restored.scroll.isPinnedToBottom).toBe(true);
		expect(jump).not.toHaveBeenCalled();
		registry.destroy();
		cache.flush();
	});

});
