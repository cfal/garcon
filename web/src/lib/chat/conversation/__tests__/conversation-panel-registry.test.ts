import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AssistantMessage, UserMessage } from '$shared/chat-types';
import type { ResendCandidate, TranscriptMessage } from '$shared/chat-view';
import type { ChatLoadMessagesOptions } from '$lib/chat/transcript/active-transcript-state.svelte.js';
import { ChatTranscriptCache } from '$lib/chat/transcript/chat-transcript-cache.svelte.js';
import { ConversationTranscriptOverlayStore } from '$lib/chat/transcript/conversation-transcript-overlay-store.svelte.js';
import { ConversationLifecycleState } from '../conversation-lifecycle-state.svelte.js';
import {
	ConversationPanelRegistry,
	type ConversationPanelDescriptor,
	type ConversationPanelSnapshotAdmission,
	type ConversationPanelPresentationPort,
} from '../conversation-panel-registry.svelte.js';
import { CurrentConversationPanelTranscript } from '../current-conversation-panel-transcript.js';
import type { ChatViewSurfaceId } from '$lib/workspace/surface-types.js';
import { transcriptPresentationKey } from '$lib/chat/transcript/transcript-presentation-key.js';
import { TRANSCRIPT_BUFFER_BYTE_LIMIT, TRANSCRIPT_BUFFER_ROW_LIMIT } from '$lib/chat/transcript/transcript-batch-buffer.js';

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
	snapshotAdmission: ConversationPanelSnapshotAdmission = 'admitted',
): ConversationPanelDescriptor {
	const windowId = surfaceId.slice('chat-view:'.length) as `window-${string}`;
	return { surfaceId, chatId, presentation: windowId, windowId, snapshotAdmission };
}

function fixture(
	options: {
		loadTranscriptSnapshot?: (
			transcript: import('$lib/chat/transcript/active-transcript-state.svelte.js').ActiveTranscriptState,
			chatId: string,
			options: ChatLoadMessagesOptions,
		) => Promise<void>;
			getComposerAnchorSurfaceId?: () => ChatViewSurfaceId | null;
			getSelectedChatId?: () => string | null;
			retainInactiveWindows?: () => boolean;
	} = {},
) {
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
		getComposerAnchorSurfaceId: options.getComposerAnchorSurfaceId ?? (() => null),
		getSelectedChatId: options.getSelectedChatId ?? (() => null),
		retainInactiveWindows: options.retainInactiveWindows,
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

function port(
	target: ConversationPanelPresentationPort['captureRestoreTarget'] extends () => infer T
		? T
		: never,
): ConversationPanelPresentationPort {
	return {
		getScrollContainer: () => null,
		getViewport: () => null,
		getQueueContainer: () => undefined,
		captureRestoreTarget: () => target,
		closeTransients: vi.fn(),
	};
}

function switchPanel(
	registry: ConversationPanelRegistry,
	chatId: string,
	surfaceId: `chat-view:window-${string}` = 'chat-view:window-left',
): void {
	const visible = [presentation(surfaceId, chatId)];
	registry.prepareForReconcile(visible);
	registry.reconcile(visible);
}

describe('ConversationPanelRegistry', () => {
	beforeEach(() => {
		localStorage.clear();
	});

	it('restores an expanded transcript immediately after rapid chat switches', () => {
		const { cache, registry } = fixture({ retainInactiveWindows: () => true });
		seed(cache, 'chat-1');
		seed(cache, 'chat-2');
		switchPanel(registry, 'chat-1');
		const first = registry.panel('chat-view:window-left')?.transcript;
		if (!first) throw new Error('Expected first transcript');
		registry.applyCommittedBatch({
			chatId: 'chat-1',
			transcriptViewId: 'view-1',
			messages: Array.from({ length: 249 }, (_, index) => message(index + 2)),
			firstOrdinal: 2,
			lastOrdinal: 250,
			resendCandidates: [],
			noticeRevision: 0,
		});
		expect(first.entries).toHaveLength(250);
		expect(cache.get('chat-1')?.messages).toHaveLength(100);

		switchPanel(registry, 'chat-2');
		expect(registry.hasInactiveWindow('chat-1')).toBe(true);
		switchPanel(registry, 'chat-1');
		const restored = registry.panel('chat-view:window-left')?.transcript;
		expect(restored).toBe(first);
		expect(restored?.entries.map((entry) => entry.ordinal)).toEqual(
			Array.from({ length: 250 }, (_, index) => index + 1),
		);
		expect(restored?.displayRows[0]).toMatchObject({ kind: 'message', ordinal: 1 });
		expect(registry.hasInactiveWindow('chat-1')).toBe(false);
		registry.destroy();
		cache.flush();
	});

	it('keeps parked windows current through background commits without changing cache fanout', () => {
		const { cache, registry } = fixture({ retainInactiveWindows: () => true });
		seed(cache, 'chat-1');
		seed(cache, 'chat-2');
		switchPanel(registry, 'chat-1');
		const first = registry.panel('chat-view:window-left')?.transcript;
		switchPanel(registry, 'chat-2');
		const cacheApply = vi.spyOn(cache, 'applyMessages');
		registry.applyCommittedBatch({
			chatId: 'chat-1',
			transcriptViewId: 'view-1',
			messages: [message(2)],
			firstOrdinal: 2,
			lastOrdinal: 2,
			resendCandidates: [],
			noticeRevision: 0,
		});
		expect(cacheApply).toHaveBeenCalledOnce();
		switchPanel(registry, 'chat-1');
		expect(registry.panel('chat-view:window-left')?.transcript).toBe(first);
		expect(first?.entries.map((entry) => entry.ordinal)).toEqual([1, 2]);
		registry.destroy();
		cache.flush();
	});

	it('keeps an expanded parked window visible through standalone overlay changes', () => {
		const { cache, registry } = fixture({ retainInactiveWindows: () => true });
		seed(cache, 'chat-1');
		seed(cache, 'chat-2');
		switchPanel(registry, 'chat-1');
		const first = registry.panel('chat-view:window-left')?.transcript;
		if (!first) throw new Error('Expected first transcript');
		registry.applyCommittedBatch({
			chatId: 'chat-1', transcriptViewId: 'view-1',
			messages: Array.from({ length: 249 }, (_, index) => message(index + 2)),
			firstOrdinal: 2, lastOrdinal: 250, resendCandidates: [], noticeRevision: 0,
		});
		switchPanel(registry, 'chat-2');

		registry.appendServerNotice('chat-1', 'info', 'background notice');
		switchPanel(registry, 'chat-1');

		expect(registry.panel('chat-view:window-left')?.transcript).toBe(first);
		expect(first.displayRows.find((row) => row.kind === 'message')).toMatchObject({ ordinal: 1 });
		registry.destroy();
		cache.flush();
	});

	it('falls back to the bounded cache when retention is disabled or the view changes', () => {
		let retainInactive = true;
		const { cache, registry } = fixture({ retainInactiveWindows: () => retainInactive });
		seed(cache, 'chat-1');
		seed(cache, 'chat-2');
		switchPanel(registry, 'chat-1');
		const first = registry.panel('chat-view:window-left')?.transcript;
		switchPanel(registry, 'chat-2');
		registry.handleViewReplacement('chat-1');
		expect(registry.hasInactiveWindow('chat-1')).toBe(false);
		cache.replace('chat-1', 'view-2', [message(1)], 1, null);
		switchPanel(registry, 'chat-1');
		expect(registry.panel('chat-view:window-left')?.transcript).not.toBe(first);
		switchPanel(registry, 'chat-2');
		retainInactive = false;
		registry.reconcile([presentation('chat-view:window-left', 'chat-2')]);
		expect(registry.hasInactiveWindow('chat-1')).toBe(false);
		switchPanel(registry, 'chat-1');
		expect(registry.panel('chat-view:window-left')?.transcript).not.toBe(first);
		registry.destroy();
		cache.flush();
	});

	it('commits one cache batch and fans it out to duplicate-chat surfaces', () => {
		const { cache, registry } = fixture();
		seed(cache);
		registry.reconcile([
			presentation('chat-view:window-left', 'chat-1'),
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
		expect(
			registry.panel('chat-view:window-left')?.transcript.entries.map((entry) => entry.ordinal),
		).toEqual([1, 2]);
		expect(
			registry.panel('chat-view:window-right')?.transcript.entries.map((entry) => entry.ordinal),
		).toEqual([1, 2]);
		cache.flush();
	});

	it('holds live shared commits behind a fixed reconnect replay watermark', () => {
		const { cache, registry } = fixture();
		seed(cache);
		registry.reconcile([
			presentation('chat-view:window-left', 'chat-1'),
			presentation('chat-view:window-right', 'chat-1'),
		]);
		const applyMessages = vi.spyOn(cache, 'applyMessages');
		const replayToken = registry.beginReconnectReplay('chat-1', 'view-1');

		expect(
			registry.applyReconnectReplayPage(replayToken, 'chat-1', {
				transcriptViewId: 'view-1',
				messages: [message(2)],
				firstOrdinal: 2,
				lastOrdinal: 2,
				resendCandidates: [],
				noticeRevision: 0,
			}),
		).toBe('applied');
		expect(
			registry.applyCommittedBatch({
				chatId: 'chat-1',
				transcriptViewId: 'view-1',
				messages: [message(4)],
				firstOrdinal: 4,
				lastOrdinal: 4,
				resendCandidates: [],
				noticeRevision: 0,
			}),
		).toEqual({ kind: 'applied', localRecoverySurfaceIds: [] });

		expect(cache.readAppliedCursor('chat-1')?.lastOrdinal).toBe(2);
		expect(
			registry.panel('chat-view:window-left')?.transcript.entries.map((entry) => entry.ordinal),
		).toEqual([1, 2]);
		expect(
			registry.applyReconnectReplayPage(replayToken, 'chat-1', {
				transcriptViewId: 'view-1',
				messages: [message(3)],
				firstOrdinal: 3,
				lastOrdinal: 3,
				resendCandidates: [],
				noticeRevision: 0,
			}),
		).toBe('applied');
		expect(registry.finishReconnectReplay(replayToken, 'chat-1')).toBe('applied');

		expect(applyMessages).toHaveBeenCalledTimes(3);
		expect(cache.readAppliedCursor('chat-1')?.lastOrdinal).toBe(4);
		for (const surfaceId of ['chat-view:window-left', 'chat-view:window-right'] as const) {
			expect(registry.panel(surfaceId)?.transcript.entries.map((entry) => entry.ordinal)).toEqual([
				1, 2, 3, 4,
			]);
		}
		cache.flush();
	});

	it('keeps duplicate surfaces independent while sharing lifecycle identity', () => {
		const { cache, registry } = fixture();
		seed(cache);
		registry.reconcile([
			presentation('chat-view:window-left', 'chat-1'),
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

	it('settles shared inputs without changing either surface interval', () => {
		const { cache, registry } = fixture();
		const messages = Array.from({ length: 200 }, (_, index) => message(index + 1));
		cache.replace('chat-1', 'view-1', messages, 200, null);
		registry.reconcile([
			presentation('chat-view:window-left', 'chat-1'),
			presentation('chat-view:window-right', 'chat-1'),
		]);
		const left = registry.panel('chat-view:window-left');
		const right = registry.panel('chat-view:window-right');
		if (!left || !right) throw new Error('Expected duplicate panels');
		left.transcript.replaceGeneration('chat-1', 'view-1', messages, {
			lastOrdinal: 200, pageOldestOrdinal: 1, nextBeforeOrdinal: null, hasMore: false,
		});
		left.scroll.setPinnedToBottom(false);
		for (const clientMessageId of ['pending-first', 'pending-second']) {
			registry.upsertOptimisticInput('chat-1', {
				chatId: 'chat-1', clientMessageId, content: clientMessageId,
				createdAt: '2026-08-30T00:00:00.000Z', delivery: 'pending',
			});
		}
		registry.markOptimisticInputDelivered('chat-1', 'pending-second');
		registry.appendLocalNotice('chat-1', 'progress', 'synthetic status');

		for (const [index, clientMessageId] of ['pending-second', 'pending-first'].entries()) {
			const ordinal = 201 + index;
			expect(registry.applyCommittedBatch({
				chatId: 'chat-1', transcriptViewId: 'view-1',
				messages: [{ ordinal, message: new UserMessage(
					'2026-08-30T00:00:00.000Z', clientMessageId, undefined, { clientMessageId },
				) }],
				firstOrdinal: ordinal, lastOrdinal: ordinal, resendCandidates: [], noticeRevision: 0,
			})).toEqual({ kind: 'applied', localRecoverySurfaceIds: [] });
			for (const [panel, firstOrdinal] of [[left, 1], [right, 101]] as const) {
				expect(panel.transcript.displayRows.flatMap((row) =>
					row.kind === 'message' && row.ordinal !== undefined ? [row.ordinal] : [],
				)).toEqual(Array.from({ length: ordinal - firstOrdinal + 1 }, (_, i) => firstOrdinal + i));
				expect(panel.transcript.displayRows.filter((row) => row.id.startsWith('optimistic:')))
					.toHaveLength(1 - index);
			}
		}
		expect(left.transcript.canLoadEarlier).toBe(false);
		expect(right.transcript.canLoadEarlier).toBe(true);
		expect(left.scroll.isPinnedToBottom).toBe(false);
		expect(right.scroll.isPinnedToBottom).toBe(true);
		registry.destroy();
		cache.flush();
	});

	it('binds the composer only when anchor, selection, and rendered panel agree', () => {
		let anchorSurfaceId: ChatViewSurfaceId | null = 'chat-view:window-left';
		let selectedChatId: string | null = 'chat-1';
		const { cache, registry } = fixture({
			getComposerAnchorSurfaceId: () => anchorSurfaceId,
			getSelectedChatId: () => selectedChatId,
		});
		seed(cache, 'chat-1');
		seed(cache, 'chat-2');
		registry.reconcile([
			presentation('chat-view:window-left', 'chat-1'),
			presentation('chat-view:window-right', 'chat-2'),
		]);

		expect(registry.composerPanel?.surfaceId).toBe('chat-view:window-left');
		expect(registry.isComposerTarget('chat-view:window-left', 'chat-1')).toBe(true);

		selectedChatId = 'chat-2';
		expect(registry.composerPanel).toBeNull();
		expect(registry.isComposerTarget('chat-view:window-left', 'chat-1')).toBe(false);

		anchorSurfaceId = 'chat-view:window-right';
		expect(registry.composerPanel?.surfaceId).toBe('chat-view:window-right');

		anchorSurfaceId = 'chat-view:window-missing';
		expect(registry.composerPanel).toBeNull();
		registry.destroy();
		cache.flush();
	});

	it('keeps duplicate draft panels deferred from transcript snapshots', async () => {
		const loadTranscriptSnapshot = vi.fn(async () => {
			throw new Error('Draft panels must not request a server transcript');
		});
		const { cache, registry } = fixture({ loadTranscriptSnapshot });

		registry.reconcile([
			presentation('chat-view:window-left', 'chat-1', 'deferred'),
			presentation('chat-view:window-right', 'chat-1', 'deferred'),
		]);
		await Promise.resolve();

		expect(registry.panel('chat-view:window-left')).not.toBeNull();
		expect(registry.panel('chat-view:window-right')).not.toBeNull();
		await expect(registry.loadChatSnapshot('chat-1')).resolves.toBe(false);
		expect(loadTranscriptSnapshot).not.toHaveBeenCalled();
		registry.destroy();
		cache.flush();
	});

	it('hydrates retained duplicate panels once when their draft becomes admitted', async () => {
		const loadTranscriptSnapshot = vi.fn(
			async (transcript, chatId: string, options: ChatLoadMessagesOptions) => {
				transcript.transcriptCache.replace(chatId, 'view-1', [message(1)], 1, null);
				transcript.installCachedSnapshot(chatId);
				expect(options).toEqual({});
			},
		);
		const { cache, registry } = fixture({ loadTranscriptSnapshot });
		const deferredPresentations = [
			presentation('chat-view:window-left', 'chat-1', 'deferred'),
			presentation('chat-view:window-right', 'chat-1', 'deferred'),
		];
		registry.reconcile(deferredPresentations);
		await Promise.resolve();
		await Promise.resolve();
		const left = registry.panel('chat-view:window-left');
		const right = registry.panel('chat-view:window-right');
		if (!left || !right) throw new Error('Expected duplicate draft panels');
		left.scroll.setPinnedToBottom(false);

		registry.reconcile([
			presentation('chat-view:window-left', 'chat-1'),
			presentation('chat-view:window-right', 'chat-1'),
		]);

		expect(registry.panel('chat-view:window-left')).toBe(left);
		expect(registry.panel('chat-view:window-right')).toBe(right);
		await vi.waitFor(() => {
			expect(loadTranscriptSnapshot).toHaveBeenCalledOnce();
			expect(left.transcript.entries.map((entry) => entry.ordinal)).toEqual([1]);
			expect(right.transcript.entries.map((entry) => entry.ordinal)).toEqual([1]);
		});
		expect(loadTranscriptSnapshot).toHaveBeenCalledWith(left.transcript, 'chat-1', {});
		expect(left.scroll.isPinnedToBottom).toBe(false);
		expect(right.scroll.isPinnedToBottom).toBe(true);
		registry.destroy();
		cache.flush();
	});

	it('hands admission hydration to a retained duplicate when its loader is removed', async () => {
		const release = deferred<void>();
		const loadTranscriptSnapshot = vi.fn(
			async (transcript, chatId: string, _options: ChatLoadMessagesOptions) => {
				const epoch = transcript.beginSnapshotLoad();
				await release.promise;
				transcript.setFromPage(
					chatId,
					{
						transcriptViewId: 'view-1',
						messages: [message(1)],
						lastOrdinal: 1,
						pageOldestOrdinal: 1,
						pageNewestOrdinal: 1,
						nextBeforeOrdinal: null,
						hasMore: false,
						resendCandidates: [],
					},
					epoch,
				);
			},
		);
		const { cache, registry } = fixture({ loadTranscriptSnapshot });
		registry.reconcile([
			presentation('chat-view:window-left', 'chat-1', 'deferred'),
			presentation('chat-view:window-right', 'chat-1', 'deferred'),
		]);
		await Promise.resolve();
		const retained = registry.panel('chat-view:window-right');
		if (!retained) throw new Error('Expected retained draft panel');

		registry.reconcile([
			presentation('chat-view:window-left', 'chat-1'),
			presentation('chat-view:window-right', 'chat-1'),
		]);
		await vi.waitFor(() => expect(loadTranscriptSnapshot).toHaveBeenCalledOnce());
		registry.reconcile([presentation('chat-view:window-right', 'chat-1')]);
		release.resolve();

		await vi.waitFor(() => {
			expect(loadTranscriptSnapshot).toHaveBeenCalledTimes(2);
			expect(retained.transcript.entries.map((entry) => entry.ordinal)).toEqual([1]);
		});
		expect(registry.panel('chat-view:window-right')).toBe(retained);
		expect(loadTranscriptSnapshot.mock.calls.map((call) => call[2])).toEqual([{}, {}]);
		registry.destroy();
		cache.flush();
	});

	it('loads one snapshot and hydrates every current duplicate-chat surface', async () => {
		const { cache, registry } = fixture();
		seed(cache);
		registry.reconcile([
			presentation('chat-view:window-left', 'chat-1'),
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

	it.each(['snapshot', 'buffer', 'cancel'] as const)('keeps one UI identity across a held snapshot and %s settlement', async (settlement) => {
		const { cache, registry } = fixture();
		seed(cache);
		registry.reconcile([
			presentation('chat-view:window-left', 'chat-1'),
			presentation('chat-view:window-right', 'chat-1'),
		]);
		const left = registry.panel('chat-view:window-left')!.transcript;
		const right = registry.panel('chat-view:window-right')!.transcript;
		registry.upsertOptimisticInput('chat-1', {
			chatId: 'chat-1', clientMessageId: 'synthetic-buffered-input',
			createdAt: '2026-01-01T00:00:00.000Z', content: 'Synthetic input', delivery: 'pending',
		});
		const epoch = left.beginSnapshotLoad();
		const echoed = { ordinal: 2, message: new UserMessage('2026-01-01T00:00:00.000Z', 'Synthetic input', undefined, {
			clientMessageId: 'synthetic-buffered-input',
		}) };
		registry.applyCommittedBatch({
			chatId: 'chat-1', transcriptViewId: 'view-1', messages: [echoed],
			firstOrdinal: 2, lastOrdinal: 2, resendCandidates: [], noticeRevision: 0,
		});
		for (const transcript of [left, right]) {
			expect(transcript.optimisticUserInputs).toHaveLength(0);
			expect(transcript.displayRows.map(transcriptPresentationKey)).toEqual([
				'view-1:1', JSON.stringify(['user-input', 'synthetic-buffered-input']),
			]);
		}
		expect(left.isLoadingMessages).toBe(true);
		expect(left.entries.map(({ ordinal }) => ordinal)).toEqual([1]);
		if (settlement === 'cancel') left.abortSnapshotLoad(epoch);
		else expect(left.setFromPage('chat-1', {
			transcriptViewId: 'view-1',
			messages: settlement === 'snapshot' ? [message(1), echoed] : [message(1)],
			lastOrdinal: settlement === 'snapshot' ? 2 : 1,
			pageOldestOrdinal: 1, pageNewestOrdinal: settlement === 'snapshot' ? 2 : 1,
			nextBeforeOrdinal: null, hasMore: false,
		}, epoch)).toBe('applied');
		expect(left.entries.map(({ ordinal }) => ordinal)).toEqual([1, 2]);
		expect(left.displayRows.at(-1)?.id).toBe('view-1:2');
		registry.destroy();
		cache.flush();
	});

	it('rebases an unknown submission frontier after the first snapshot without placing it above history', async () => {
		const release = deferred<void>();
		const { cache, registry } = fixture({ loadTranscriptSnapshot: async (transcript) => {
			const epoch = transcript.beginSnapshotLoad();
			await release.promise;
			transcript.setFromPage('chat-1', {
				transcriptViewId: 'view-1', messages: [message(1)], lastOrdinal: 1,
				pageOldestOrdinal: 1, pageNewestOrdinal: 1, nextBeforeOrdinal: null, hasMore: false,
			}, epoch);
		} });
		registry.reconcile([presentation('chat-view:window-left', 'chat-1')]);
		registry.upsertOptimisticInput('chat-1', {
			chatId: 'chat-1', clientMessageId: 'unknown-frontier', content: 'Synthetic pending input',
			createdAt: '2026-01-01T00:00:00.000Z', delivery: 'pending',
		});
		release.resolve();
		await registry.loadChatSnapshot('chat-1');
		const transcript = registry.panel('chat-view:window-left')!.transcript;
		expect(transcript.displayRows.map((row) => row.id)).toEqual(['view-1:1', 'optimistic:unknown-frontier']);
		registry.applyCommittedBatch({
			chatId: 'chat-1', transcriptViewId: 'view-1', messages: [message(2)],
			firstOrdinal: 2, lastOrdinal: 2, resendCandidates: [], noticeRevision: 0,
		});
		expect(transcript.displayRows.map((row) => row.id)).toEqual(['view-1:1', 'optimistic:unknown-frontier', 'view-1:2']);
		registry.destroy();
		cache.flush();
	});

	it('settles a disjoint snapshot echo before cache eviction, including parked windows', async () => {
		const { cache, registry } = fixture({
			retainInactiveWindows: () => true,
			loadTranscriptSnapshot: async (transcript, chatId) => {
				const messages = Array.from({ length: 200 }, (_, index) => message(index + 101));
				messages[0] = { ordinal: 101, message: new UserMessage('', 'Synthetic input', undefined, { clientMessageId: 'disjoint-input' }) };
				expect(transcript.setFromPage(chatId, {
					transcriptViewId: 'view-1', messages, lastOrdinal: 300,
					pageOldestOrdinal: 101, pageNewestOrdinal: 300, nextBeforeOrdinal: 101, hasMore: true,
				}, transcript.beginSnapshotLoad())).toBe('applied');
			},
		});
		seed(cache);
		registry.reconcile([presentation('chat-view:window-left', 'chat-1'), presentation('chat-view:window-right', 'chat-1')]);
		const left = registry.panel('chat-view:window-left')!.transcript;
		const right = registry.panel('chat-view:window-right')!.transcript;
		registry.upsertOptimisticInput('chat-1', {
			chatId: 'chat-1', clientMessageId: 'disjoint-input', content: 'Synthetic input', createdAt: '', delivery: 'pending',
		});
		registry.prepareForReconcile([presentation('chat-view:window-left', 'chat-1')]);
		registry.reconcile([presentation('chat-view:window-left', 'chat-1')]);
		expect(registry.hasInactiveWindow('chat-1')).toBe(true);
		await expect(registry.loadChatSnapshot('chat-1')).resolves.toBe(true);
		for (const transcript of [left, right]) {
			expect(transcript.entries.map((row) => row.ordinal)).toEqual([1]);
			expect(transcript.displayRows.map((row) => row.id)).toEqual(['view-1:1']);
			expect(transcript.optimisticUserInputs).toEqual([]);
			expect(transcript.lastOrdinal).toBe(300);
		}
		expect(cache.get('chat-1')?.messages[0]?.ordinal).toBe(201);
		registry.reconcile([presentation('chat-view:window-left', 'chat-1'), presentation('chat-view:window-right', 'chat-1')]);
		expect(registry.panel('chat-view:window-right')!.transcript).toBe(right);
		left.activateChat('chat-1');
		expect(left.displayRows).toHaveLength(100);
		expect(left.displayRows.every((row) => !row.id.startsWith('optimistic:'))).toBe(true);
		registry.destroy();
		cache.flush();
	});

	it('settles a published snapshot after its loader disappears and a peer retries publication', async () => {
		let removedLoader = false;
		const { cache, registry } = fixture({ loadTranscriptSnapshot: async (transcript, chatId) => {
			transcript.setFromPage(chatId, {
				transcriptViewId: 'view-1', messages: [message(1), {
					ordinal: 2, message: new UserMessage('', 'Synthetic input', undefined, { clientMessageId: 'removed-loader' }),
				}], lastOrdinal: 2, pageOldestOrdinal: 1, pageNewestOrdinal: 2, nextBeforeOrdinal: null, hasMore: false,
			}, transcript.beginSnapshotLoad());
			if (!removedLoader) {
				removedLoader = true;
				registry.reconcile([presentation('chat-view:window-right', chatId)]);
			}
		} });
		seed(cache);
		registry.reconcile([presentation('chat-view:window-left', 'chat-1'), presentation('chat-view:window-right', 'chat-1')]);
		registry.upsertOptimisticInput('chat-1', {
			chatId: 'chat-1', clientMessageId: 'removed-loader', content: 'Synthetic input', createdAt: '', delivery: 'pending',
		});
		await expect(registry.loadChatSnapshot('chat-1')).resolves.toBe(true);
		expect(registry.overlayFor('chat-1')?.optimisticInputs).toEqual([]);
		expect(registry.panel('chat-view:window-right')!.transcript.displayRows.map((row) => row.id)).toEqual(['view-1:1', 'view-1:2']);
		registry.destroy();
		cache.flush();
	});

	it('rebases a submission made against a stale frontier after replacement history arrives', async () => {
		const { cache, registry } = fixture({ loadTranscriptSnapshot: async (transcript, chatId) => {
			transcript.setFromPage(chatId, {
				transcriptViewId: 'view-2', messages: [message(150), message(200)], lastOrdinal: 200,
				pageOldestOrdinal: 150, pageNewestOrdinal: 200, nextBeforeOrdinal: 150, hasMore: true,
			}, transcript.beginSnapshotLoad());
		} });
		cache.replace('chat-1', 'view-1', [message(100)], 100, 100);
		registry.reconcile([presentation('chat-view:window-left', 'chat-1')]);
		cache.markStale('chat-1');
		registry.upsertOptimisticInput('chat-1', {
			chatId: 'chat-1', clientMessageId: 'stale-frontier', content: 'Synthetic input', createdAt: '', delivery: 'pending',
		});
		await registry.loadChatSnapshot('chat-1');
		expect(registry.panel('chat-view:window-left')!.transcript.displayRows.map((row) => row.id)).toEqual([
			'view-2:150', 'view-2:200', 'optimistic:stale-frontier',
		]);
		expect(registry.overlayFor('chat-1')?.optimisticAfterOrdinals.get('stale-frontier')).toBe(200);
		registry.destroy();
		cache.flush();
	});

	it.each(['rows', 'bytes'] as const)('keeps echo evidence across replay %s overflow, abort, failed recovery and a disjoint snapshot', async (limit) => {
		let failRecovery = true;
		const through = TRANSCRIPT_BUFFER_ROW_LIMIT + 200;
		const { cache, registry } = fixture({ loadTranscriptSnapshot: async (transcript, chatId) => {
			if (failRecovery) throw new Error('Synthetic recovery failure');
			transcript.setFromPage(chatId, {
				transcriptViewId: 'view-1', messages: [message(through)], lastOrdinal: through,
				pageOldestOrdinal: through, pageNewestOrdinal: through, nextBeforeOrdinal: through, hasMore: true,
			}, transcript.beginSnapshotLoad());
		} });
		seed(cache);
		registry.reconcile([presentation('chat-view:window-left', 'chat-1')]);
		registry.upsertOptimisticInput('chat-1', {
			chatId: 'chat-1', clientMessageId: 'replay-input', content: 'Synthetic input', createdAt: '', delivery: 'pending',
		});
		const token = registry.beginReconnectReplay('chat-1', 'view-1');
		const echoed = { chatId: 'chat-1', transcriptViewId: 'view-1', messages: [
			{ ordinal: 101, message: new UserMessage('', 'Synthetic input', undefined, { clientMessageId: 'replay-input' }) },
		], firstOrdinal: 101, lastOrdinal: 101, resendCandidates: [], noticeRevision: 0 };
		const transcript = registry.panel('chat-view:window-left')!.transcript;
		const revision = transcript.feedMutationClock.dataRevision;
		expect(registry.applyCommittedBatch(echoed).kind).toBe('applied');
		expect(transcript.feedMutationClock.dataRevision).toBeGreaterThan(revision);
		expect(transcript.displayRows.at(-1)).not.toHaveProperty('awaitingDelivery', true);
		expect(registry.applyCommittedBatch({
			...echoed, firstOrdinal: 102, lastOrdinal: through,
			messages: limit === 'rows' ? [] : [{ ordinal: through, message: new AssistantMessage('', 'x'.repeat(TRANSCRIPT_BUFFER_BYTE_LIMIT)) }],
			...(limit === 'bytes' ? { firstOrdinal: through } : {}),
		}).kind).toBe('chat-recovery-required');
		expect(registry.applyReconnectReplayPage(token, 'chat-1', { ...echoed, messages: [], firstOrdinal: 2, lastOrdinal: 100 })).toBe('gap-detected');
		registry.abortReconnectReplay(token, 'chat-1');
		expect(cache.readAppliedCursor('chat-1')?.lastOrdinal).toBe(1);
		await expect(registry.loadChatSnapshot('chat-1')).rejects.toThrow('Synthetic recovery failure');
		expect(registry.overlayFor('chat-1')?.optimisticInputs).toMatchObject([{ clientMessageId: 'replay-input', delivery: 'delivered' }]);
		expect(transcript.displayRows.at(-1)).not.toHaveProperty('awaitingDelivery', true);
		failRecovery = false;
		await expect(registry.loadChatSnapshot('chat-1')).resolves.toBe(true);
		expect(cache.readAppliedCursor('chat-1')?.lastOrdinal).toBe(through);
		expect(registry.panel('chat-view:window-left')!.transcript.loadedThroughOrdinal).toBe(1);
		expect(registry.overlayFor('chat-1')?.optimisticInputs).toHaveLength(0);
		const resumed = registry.beginReconnectReplay('chat-1', 'view-1');
		expect(registry.applyReconnectReplayPage(resumed, 'chat-1', { ...echoed, firstOrdinal: through + 1, lastOrdinal: through + 1, messages: [message(through + 1)] })).toBe('applied');
		expect(registry.finishReconnectReplay(resumed, 'chat-1')).toBe('applied');
		expect(cache.readAppliedCursor('chat-1')?.lastOrdinal).toBe(through + 1);
		registry.destroy();
		cache.flush();
	});

	it('shares one initial snapshot request across duplicate-chat surfaces', async () => {
		const loadTranscriptSnapshot = vi.fn(async (transcript, chatId: string) => {
			transcript.transcriptCache.replace(chatId, 'view-1', [message(1)], 1, null);
			transcript.installCachedSnapshot(chatId);
		});
		const { cache, registry } = fixture({
			loadTranscriptSnapshot,
			getComposerAnchorSurfaceId: () => 'chat-view:window-left',
			getSelectedChatId: () => 'chat-1',
		});

		registry.reconcile([
			presentation('chat-view:window-left', 'chat-1'),
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
			transcript.setFromPage(
				chatId,
				{
					transcriptViewId: 'view-1',
					messages: [message(1)],
					lastOrdinal: 1,
					pageOldestOrdinal: 1,
					pageNewestOrdinal: 1,
					nextBeforeOrdinal: null,
					hasMore: false,
					resendCandidates: [candidate(1)],
				},
				epoch,
			);
		});
		const { cache, registry } = fixture({ loadTranscriptSnapshot });

		registry.reconcile([
			presentation('chat-view:window-left', 'chat-1'),
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
			presentation('chat-view:window-left', 'chat-1'),
			presentation('chat-view:window-right', 'chat-1'),
		]);
		const selected = new CurrentConversationPanelTranscript({
			panels: registry,
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

	it('exposes revision-scoped notice clearing for the selected chat', () => {
		const { registry, overlays } = fixture({ getSelectedChatId: () => 'chat-1' });
		const selected = new CurrentConversationPanelTranscript({
			panels: registry,
			getSelectedChatId: () => 'chat-1',
		});

		selected.appendLocalNotice('progress', 'Forking chat...');
		expect(selected.noticeRevisionForChat('chat-1')).toBe(1);
		selected.appendLocalNotice('error', 'Failed to fork chat: unavailable');

		selected.clearLocalNoticesForChat('chat-1', 1);

		expect(overlays.forChat('chat-1').notices.map((notice) => notice.content)).toEqual([
			'Failed to fork chat: unavailable',
		]);

		selected.clearLocalNoticesForChat('chat-1');

		expect(overlays.forChat('chat-1').notices).toEqual([]);
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
		registry.reconcile([presentation('chat-view:window-left', 'chat-1')]);
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
			presentation('chat-view:window-left', 'chat-1'),
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
		expect(right.transcript.displayRows).toHaveLength(50);
		expect(right.transcript.hasLaterMessages).toBe(true);
		expect(right.transcript.isUserScrolledUp).toBe(true);
		expect(right.scroll.isPinnedToBottom).toBe(false);
		cache.flush();
	});

	it('projects selection onto a mounted surface without resetting either duplicate transcript', () => {
		const { cache, registry } = fixture({
			getComposerAnchorSurfaceId: () => 'chat-view:window-right',
			getSelectedChatId: () => 'chat-1',
		});
		seed(cache);
		registry.reconcile([
			presentation('chat-view:window-left', 'chat-1'),
			presentation('chat-view:window-right', 'chat-1'),
		]);
		const left = registry.panel('chat-view:window-left');
		const right = registry.panel('chat-view:window-right');
		if (!left || !right) throw new Error('Expected duplicate panels');
		const leftEntries = [message(1)];
		const rightEntries = Array.from({ length: 150 }, (_, index) => message(index + 1));
		left.transcript.entries = leftEntries;
		right.transcript.entries = rightEntries;
		right.transcript.hasLaterMessages = true;
		right.transcript.isUserScrolledUp = true;
		right.scroll.setPinnedToBottom(false);
		const preservedLeftEntries = left.transcript.entries;
		const preservedRightEntries = right.transcript.entries;
		const selected = new CurrentConversationPanelTranscript({
			panels: registry,
			getSelectedChatId: () => 'chat-1',
		});

		expect(selected.hasMountedPresentation('chat-1')).toBe(true);
		expect(selected.activateChat('chat-1')).toBeNull();

		expect(left.transcript.entries).toBe(preservedLeftEntries);
		expect(right.transcript.entries).toBe(preservedRightEntries);
		expect(right.transcript.displayRows).toHaveLength(150);
		expect(right.transcript.hasLaterMessages).toBe(true);
		expect(right.transcript.isUserScrolledUp).toBe(true);
		expect(right.scroll.isPinnedToBottom).toBe(false);
		cache.flush();
	});

	it('recognizes a rendered target during the pointerdown-to-anchor mismatch', () => {
		const { cache, registry } = fixture({
			getComposerAnchorSurfaceId: () => 'chat-view:window-left',
			getSelectedChatId: () => 'chat-2',
		});
		seed(cache, 'chat-1');
		seed(cache, 'chat-2');
		registry.reconcile([
			presentation('chat-view:window-left', 'chat-1'),
			presentation('chat-view:window-right', 'chat-2'),
		]);
		const selected = new CurrentConversationPanelTranscript({
			panels: registry,
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
		registry.reconcile([presentation('chat-view:window-left', 'chat-1')]);
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

	it('purges optimistic input ownership when its chat is discarded', () => {
		const { cache, registry } = fixture();
		seed(cache);
		registry.reconcile([presentation('chat-view:window-left', 'chat-1')]);
		const selected = new CurrentConversationPanelTranscript({
			panels: registry,
			getSelectedChatId: () => 'chat-1',
		});
		selected.upsertOptimisticUserInput({
			chatId: 'chat-1',
			clientMessageId: 'input-1',
			content: 'pending',
			createdAt: '2026-08-30T00:00:00.000Z',
			delivery: 'pending',
		});
		const markDelivered = vi.spyOn(registry, 'markOptimisticInputDelivered');

		selected.discardChat('chat-1');
		selected.markOptimisticUserInputDelivered('input-1');

		expect(markDelivered).not.toHaveBeenCalled();
		registry.destroy();
		cache.flush();
	});

	it('purges optimistic input ownership when its committed echo arrives', () => {
		const { cache, registry } = fixture();
		seed(cache);
		registry.reconcile([presentation('chat-view:window-left', 'chat-1')]);
		const selected = new CurrentConversationPanelTranscript({
			panels: registry,
			getSelectedChatId: () => 'chat-1',
		});
		selected.upsertOptimisticUserInput({
			chatId: 'chat-1',
			clientMessageId: 'input-1',
			content: 'pending',
			createdAt: '2026-08-30T00:00:00.000Z',
			delivery: 'pending',
		});
		selected.applyMessages(
			'chat-1',
			'view-1',
			[
				{
					ordinal: 2,
					message: new UserMessage('2026-08-30T00:00:01.000Z', 'pending', undefined, {
						clientMessageId: 'input-1',
					}),
				},
			],
			2,
			2,
		);
		const markDelivered = vi.spyOn(registry, 'markOptimisticInputDelivered');

		selected.markOptimisticUserInputDelivered('input-1');

		expect(markDelivered).not.toHaveBeenCalled();
		registry.destroy();
		cache.flush();
	});

	it('captures a panel target before presentation teardown and consumes it on restore', () => {
		const { cache, registry } = fixture();
		seed(cache);
		const visible = [presentation('chat-view:window-left', 'chat-1')];
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

	it('transfers a captured row target when a Chat move rekeys its surface', async () => {
		const { cache, registry } = fixture();
		seed(cache);
		registry.reconcile([presentation('chat-view:window-left', 'chat-1')]);
		const source = registry.panel('chat-view:window-left');
		if (!source) throw new Error('Expected source panel');
		const target = {
			kind: 'row' as const,
			transcriptViewId: 'view-1',
			ordinal: 1,
			viewportOffset: -17,
		};
		source.attachPresentation(port(target));
		const publication = registry.prepareChatSurfaceTransfer({
			sourceSurfaceId: 'chat-view:window-left',
			destinationSurfaceId: 'chat-view:window-right',
			chatId: 'chat-1',
		});

		publication.publish();
		const visible = [presentation('chat-view:window-right', 'chat-1')];
		registry.prepareForReconcile(visible);
		registry.reconcile(visible);
		const destination = registry.panel('chat-view:window-right');
		if (!destination) throw new Error('Expected destination panel');
		const jump = vi.spyOn(destination.scroll, 'jumpToMessageRow').mockResolvedValue('completed');
		destination.attachPresentation(port({ kind: 'end' }));

		await vi.waitFor(() => expect(jump).toHaveBeenCalledOnce());
		expect(jump).toHaveBeenCalledWith(
			{
				chatId: 'chat-1',
				transcriptViewId: 'view-1',
				rowId: 'view-1:1',
			},
			{ viewportOffset: -17 },
		);
		registry.destroy();
		cache.flush();
	});

	it('transfers a retained transcript window with its row target when a Chat moves', async () => {
		const { cache, registry } = fixture({ retainInactiveWindows: () => true });
		seed(cache);
		registry.reconcile([presentation('chat-view:window-left', 'chat-1')]);
		const source = registry.panel('chat-view:window-left');
		if (!source) throw new Error('Expected source panel');
		registry.applyCommittedBatch({
			chatId: 'chat-1', transcriptViewId: 'view-1',
			messages: Array.from({ length: 149 }, (_, index) => message(index + 2)),
			firstOrdinal: 2, lastOrdinal: 150, resendCandidates: [], noticeRevision: 0,
		});
		const target = {
			kind: 'row' as const,
			transcriptViewId: 'view-1',
			ordinal: 1,
			viewportOffset: -17,
		};
		source.attachPresentation(port(target));
		registry.prepareChatSurfaceTransfer({
			sourceSurfaceId: 'chat-view:window-left',
			destinationSurfaceId: 'chat-view:window-right',
			chatId: 'chat-1',
		}).publish();
		const visible = [presentation('chat-view:window-right', 'chat-1')];
		registry.prepareForReconcile(visible);
		registry.reconcile(visible);
		const destination = registry.panel('chat-view:window-right');
		if (!destination) throw new Error('Expected destination panel');
		const jump = vi.spyOn(destination.scroll, 'jumpToMessageRow').mockResolvedValue('completed');
		destination.attachPresentation(port({ kind: 'end' }));

		await vi.waitFor(() => expect(jump).toHaveBeenCalledOnce());
		expect(destination.transcript).toBe(source.transcript);
		expect(destination.transcript.entries).toHaveLength(150);
		expect(jump).toHaveBeenCalledWith(
			{ chatId: 'chat-1', transcriptViewId: 'view-1', rowId: 'view-1:1' },
			{ viewportOffset: -17 },
		);
		registry.destroy();
		cache.flush();
	});

	it('prefers the source window over parked destination state during a Chat move', async () => {
		const { cache, registry } = fixture({ retainInactiveWindows: () => true });
		seed(cache, 'chat-1');
		seed(cache, 'chat-2');
		switchPanel(registry, 'chat-1', 'chat-view:window-right');
		switchPanel(registry, 'chat-2', 'chat-view:window-right');
		registry.reconcile([
			presentation('chat-view:window-left', 'chat-1'),
			presentation('chat-view:window-right', 'chat-2'),
		]);
		const source = registry.panel('chat-view:window-left');
		if (!source) throw new Error('Expected source panel');
		registry.applyCommittedBatch({
			chatId: 'chat-1', transcriptViewId: 'view-1',
			messages: Array.from({ length: 149 }, (_, index) => message(index + 2)),
			firstOrdinal: 2, lastOrdinal: 150, resendCandidates: [], noticeRevision: 0,
		});
		const target = {
			kind: 'row' as const, transcriptViewId: 'view-1', ordinal: 1, viewportOffset: -17,
		};
		source.attachPresentation(port(target));
		registry.prepareChatSurfaceTransfer({
			sourceSurfaceId: 'chat-view:window-left',
			destinationSurfaceId: 'chat-view:window-right',
			chatId: 'chat-1',
		}).publish();
		const visible = [presentation('chat-view:window-right', 'chat-1')];
		registry.prepareForReconcile(visible);
		registry.reconcile(visible);
		const destination = registry.panel('chat-view:window-right');
		if (!destination) throw new Error('Expected destination panel');
		const jump = vi.spyOn(destination.scroll, 'jumpToMessageRow').mockResolvedValue('completed');
		destination.attachPresentation(port({ kind: 'end' }));

		await vi.waitFor(() => expect(jump).toHaveBeenCalledOnce());
		expect(destination.transcript).toBe(source.transcript);
		expect(destination.transcript.entries).toHaveLength(150);
		registry.destroy();
		cache.flush();
	});

	it('reserves a large source window before parking the outgoing destination', () => {
		const { cache, registry } = fixture({ retainInactiveWindows: () => true });
		seed(cache, 'chat-1');
		seed(cache, 'chat-2');
		registry.reconcile([
			presentation('chat-view:window-left', 'chat-1'),
			presentation('chat-view:window-right', 'chat-2'),
		]);
		const source = registry.panel('chat-view:window-left');
		if (!source) throw new Error('Expected source panel');
		registry.applyCommittedBatch({
			chatId: 'chat-1', transcriptViewId: 'view-1',
			messages: Array.from({ length: 7_899 }, (_, index) => message(index + 2)),
			firstOrdinal: 2, lastOrdinal: 7_900, resendCandidates: [], noticeRevision: 0,
		});
		registry.applyCommittedBatch({
			chatId: 'chat-2', transcriptViewId: 'view-1',
			messages: Array.from({ length: 199 }, (_, index) => message(index + 2)),
			firstOrdinal: 2, lastOrdinal: 200, resendCandidates: [], noticeRevision: 0,
		});
		registry.prepareChatSurfaceTransfer({
			sourceSurfaceId: 'chat-view:window-left',
			destinationSurfaceId: 'chat-view:window-right',
			chatId: 'chat-1',
		}).publish();
		const visible = [presentation('chat-view:window-right', 'chat-1')];
		registry.prepareForReconcile(visible);
		registry.reconcile(visible);

		const destination = registry.panel('chat-view:window-right');
		expect(destination?.transcript).toBe(source.transcript);
		expect(destination?.transcript.entries).toHaveLength(7_900);
		registry.destroy();
		cache.flush();
	});

	it('keeps an existing duplicate destination viewport during a Chat move', () => {
		const { cache, registry } = fixture();
		seed(cache);
		const visible = [
			presentation('chat-view:window-left', 'chat-1'),
			presentation('chat-view:window-right', 'chat-1'),
		];
		registry.reconcile(visible);
		const source = registry.panel('chat-view:window-left');
		const destination = registry.panel('chat-view:window-right');
		if (!source || !destination) throw new Error('Expected duplicate panels');
		source.attachPresentation(
			port({
				kind: 'row',
				transcriptViewId: 'view-1',
				ordinal: 1,
				viewportOffset: -3,
			}),
		);
		const destinationTarget = {
			kind: 'row' as const,
			transcriptViewId: 'view-1',
			ordinal: 1,
			viewportOffset: -31,
		};
		destination.attachPresentation(port(destinationTarget));
		const publication = registry.prepareChatSurfaceTransfer({
			sourceSurfaceId: 'chat-view:window-left',
			destinationSurfaceId: 'chat-view:window-right',
			chatId: 'chat-1',
		});

		publication.publish();
		const remaining = [presentation('chat-view:window-right', 'chat-1')];
		registry.prepareForReconcile(remaining);
		registry.reconcile(remaining);

		expect(registry.panel('chat-view:window-right')).toBe(destination);
		expect(destination.captureRestoreTarget()).toEqual(destinationTarget);
		registry.destroy();
		cache.flush();
	});

	it('discards a rolled-back surface rekey target', async () => {
		const { cache, registry } = fixture();
		seed(cache);
		registry.reconcile([presentation('chat-view:window-left', 'chat-1')]);
		const source = registry.panel('chat-view:window-left');
		if (!source) throw new Error('Expected source panel');
		source.attachPresentation(
			port({
				kind: 'row',
				transcriptViewId: 'view-1',
				ordinal: 1,
				viewportOffset: -17,
			}),
		);
		const publication = registry.prepareChatSurfaceTransfer({
			sourceSurfaceId: 'chat-view:window-left',
			destinationSurfaceId: 'chat-view:window-right',
			chatId: 'chat-1',
		});
		publication.publish();
		publication.rollback();

		const visible = [presentation('chat-view:window-right', 'chat-1')];
		registry.prepareForReconcile(visible);
		registry.reconcile(visible);
		const destination = registry.panel('chat-view:window-right');
		if (!destination) throw new Error('Expected destination panel');
		const jump = vi.spyOn(destination.scroll, 'jumpToMessageRow').mockResolvedValue('completed');
		destination.attachPresentation(port({ kind: 'end' }));
		await Promise.resolve();

		expect(destination.scroll.isPinnedToBottom).toBe(true);
		expect(jump).not.toHaveBeenCalled();
		registry.destroy();
		cache.flush();
	});

	it('restores a detached row at its captured viewport offset', async () => {
		const { cache, registry } = fixture();
		seed(cache);
		registry.reconcile([presentation('chat-view:window-left', 'chat-1')]);
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

	it('restores a collapsed group summary without requesting exact-member reveal', async () => {
		const { cache, registry } = fixture();
		seed(cache);
		registry.reconcile([presentation('chat-view:window-left', 'chat-1')]);
		const panel = registry.panel('chat-view:window-left');
		if (!panel) throw new Error('Expected panel');
		const jump = vi.spyOn(panel.scroll, 'jumpToMessageRow').mockResolvedValue('completed');
		panel.attachPresentation(port({ kind: 'end' }));
		await panel.restore({
			kind: 'group-summary', transcriptViewId: 'view-1', ordinal: 1, viewportOffset: 9,
		});
		expect(jump).toHaveBeenCalledWith({
			chatId: 'chat-1', transcriptViewId: 'view-1', rowId: 'view-1:1',
		}, { viewportOffset: 9, presentation: 'group-summary' });
		registry.destroy();
		cache.flush();
	});

	it('defers a detached row restore until its presentation attaches', async () => {
		const { cache, registry } = fixture();
		seed(cache);
		registry.reconcile([presentation('chat-view:window-left', 'chat-1')]);
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
		registry.reconcile([presentation('chat-view:window-left', 'chat-1')]);
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
		const visible = [presentation('chat-view:window-left', 'chat-1')];
		registry.reconcile(visible);
		const first = registry.panel('chat-view:window-left');
		if (!first) throw new Error('Expected panel');
		first.attachPresentation(
			port({
				kind: 'row',
				transcriptViewId: 'view-1',
				ordinal: 1,
				viewportOffset: -3,
			}),
		);

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
