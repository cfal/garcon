import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AssistantMessage, UserMessage } from '$shared/chat-types';
import type { ResendCandidate, TranscriptMessage } from '$shared/chat-view';
import type {
	ActiveTranscriptState,
	ChatLoadMessagesOptions,
} from '$lib/chat/transcript/active-transcript-state.svelte.js';
import {
	CHAT_TRANSCRIPT_CACHE_LIMIT,
	ChatTranscriptCache,
} from '$lib/chat/transcript/chat-transcript-cache.svelte.js';
import { ConversationTranscriptOverlayStore } from '$lib/chat/transcript/conversation-transcript-overlay-store.svelte.js';
import { ConversationLifecycleState } from '../conversation-lifecycle-state.svelte.js';
import {
	ConversationPanelRegistry,
	type ConversationPanelDescriptor,
	type ConversationPanelSnapshotAdmission,
	type ConversationPanelPresentationPort,
} from '../conversation-panel-registry.svelte.js';
import { CurrentConversationPanelTranscript } from '../current-conversation-panel-transcript.js';
import {
	WORKSPACE_WINDOW_RESOURCE_CEILING,
	type ChatViewSurfaceId,
} from '$lib/workspace/surface-types.js';

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
		maxHiddenEntries?: number;
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
	const cache = new ChatTranscriptCache({
		limit: 100,
		maxHiddenEntries: options.maxHiddenEntries,
		persistenceDelayMs: 60_000,
	});
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
		prepareForHide: vi.fn(),
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

	it('bounds retention to 25 visible and 25 hidden chat tails', () => {
		expect(WORKSPACE_WINDOW_RESOURCE_CEILING).toBe(25);
		expect(CHAT_TRANSCRIPT_CACHE_LIMIT).toBe(25);
	});

	it.each([false, true])('retains attached fullscreen chats without parking them (combined: %s)', async (retainInactive) => {
		const loadTranscriptSnapshot = vi.fn();
		const { cache, registry } = fixture({ retainInactiveWindows: () => retainInactive, loadTranscriptSnapshot });
		const left = presentation('chat-view:window-left', 'left');
		const right = presentation('chat-view:window-right', 'right');
		seed(cache, 'left');
		seed(cache, 'right');
		registry.reconcile([left, right]);
		const original = registry.panel(right.surfaceId)!;
		const view = port({ kind: 'end' });
		original.attachPresentation(view);
		registry.prepareForReconcile([left]);
		registry.reconcile([left], [right]);
		expect(registry.panel(right.surfaceId)).toBe(original);
		expect(registry.visibleChatIds()).toEqual(['left']);
		expect(registry.hasInactiveWindow('right')).toBe(false);
		expect(original.isPresentationVisible).toBe(false);
		expect(view.closeTransients).toHaveBeenCalled();
		for (const ordinal of [2, 3]) {
			expect(registry.applyCommittedBatch({ chatId: 'right', transcriptViewId: 'view-1',
				firstOrdinal: ordinal, lastOrdinal: ordinal, messages: [message(ordinal)],
				resendCandidates: [], noticeRevision: 0,
			})).toEqual({ kind: 'applied', localRecoverySurfaceIds: [] });
		}
		registry.reconcile([left, right]);
		expect(registry.panel(right.surfaceId)).toBe(original);
		expect(original.isPresentationVisible).toBe(true);
		expect(original.transcript.entries).toEqual([message(1), message(2), message(3)]);
		expect(loadTranscriptSnapshot).not.toHaveBeenCalled();
		registry.destroy();
		cache.flush();
	});

	it('never creates a hidden panel or retains an unattached panel', () => {
		const { cache, registry } = fixture();
		const hidden = presentation('chat-view:window-hidden', 'hidden');
		seed(cache, 'hidden');
		registry.reconcile([], [hidden]);
		expect(registry.panel(hidden.surfaceId)).toBeNull();
		registry.reconcile([hidden]);
		expect(registry.panel(hidden.surfaceId)).not.toBeNull();
		registry.reconcile([], [hidden]);
		expect(registry.panel(hidden.surfaceId)).toBeNull();
		registry.destroy();
		cache.flush();
	});

	it.each([false, true])('rechecks hidden freshness before reveal (combined: %s)', retainInactive => {
		const loadTranscriptSnapshot = vi.fn();
		const { cache, registry } = fixture({ retainInactiveWindows: () => retainInactive, loadTranscriptSnapshot });
		const hidden = presentation('chat-view:window-hidden', 'hidden');
		seed(cache, 'hidden');
		registry.reconcile([hidden]);
		const original = registry.panel(hidden.surfaceId)!;
		original.attachPresentation(port({ kind: 'end' }));
		registry.prepareForReconcile([]);
		registry.reconcile([], [hidden]);
		cache.markStaleExcept(new Set());
		registry.prepareForReconcile([hidden]);
		registry.reconcile([hidden]);
		expect(registry.panel(hidden.surfaceId)).not.toBe(original);
		expect(loadTranscriptSnapshot).toHaveBeenCalledOnce();
		expect(registry.hasInactiveWindow('hidden')).toBe(false);
		registry.destroy();
		cache.flush();
	});

	it.each([false, true])('preserves visible desktop/mobile handoff without parking (combined: %s)', retainInactive => {
		const { cache, registry } = fixture({ retainInactiveWindows: () => retainInactive });
		const desktop = presentation('chat-view:window-one', 'chat-1');
		seed(cache);
		registry.reconcile([desktop]);
		const original = registry.panel(desktop.surfaceId)!;
		original.attachPresentation(port({ kind: 'end' }));
		const mobile = { ...desktop, presentation: 'mobile', windowId: null } as const;
		for (const descriptor of [mobile, desktop]) {
			registry.prepareForReconcile([descriptor]);
			registry.reconcile([descriptor]);
			expect(registry.panel(desktop.surfaceId)).toBe(original);
			expect(original.isPresentationVisible).toBe(true);
			expect(registry.hasInactiveWindow('chat-1')).toBe(false);
		}
		registry.reconcile([], [desktop]);
		registry.prepareForReconcile([mobile]);
		registry.reconcile([mobile]);
		expect(registry.panel(desktop.surfaceId)).not.toBe(original);
		registry.destroy();
		cache.flush();
	});

	it('keeps the reading target when a hidden panel is discarded', async () => {
		const { cache, registry } = fixture({ loadTranscriptSnapshot: async (transcript, chatId) => {
			seed(cache, chatId);
			transcript.installCachedSnapshot(chatId);
		} });
		const hidden = presentation('chat-view:window-hidden', 'hidden');
		const target = { kind: 'row', transcriptViewId: 'view-1', ordinal: 1, viewportOffset: -12 } as const;
		seed(cache, 'hidden');
		registry.reconcile([hidden]);
		registry.panel(hidden.surfaceId)!.attachPresentation(port(target));
		registry.prepareForReconcile([]);
		registry.reconcile([], [hidden]);
		registry.discardFullscreenHiddenPanels();
		registry.reconcile([hidden]);
		await registry.loadChatSnapshot('hidden');
		expect(registry.panel(hidden.surfaceId)!.captureRestoreTarget()).toEqual(target);
		registry.destroy();
		cache.flush();
	});

	it('keeps 24 fullscreen-hidden cache bases pinned under background churn', () => {
		const { cache, registry } = fixture();
		const presentations = Array.from({ length: 25 }, (_, index) =>
			presentation(`chat-view:window-${index}`, `chat-${index}`));
		for (const { chatId } of presentations) seed(cache, chatId);
		registry.reconcile(presentations);
		const originals = presentations.map(({ surfaceId }) => registry.panel(surfaceId)!);
		for (const panel of originals) panel.attachPresentation(port({ kind: 'end' }));
		registry.prepareForReconcile(presentations.slice(0, 1));
		registry.reconcile(presentations.slice(0, 1), presentations.slice(1));
		for (let index = 0; index < 26; index++) seed(cache, `background-${index}`);
		for (let index = 0; index < presentations.length; index++) {
			const item = presentations[index]!;
			expect(registry.panel(item.surfaceId)).toBe(originals[index]);
			expect(cache.get(item.chatId)?.messages).toEqual([message(1)]);
		}
		expect(cache.get('background-0')).toBeNull();
		registry.destroy();
		cache.flush();
	});

	it.each(['stale', 'view-replacement', 'disconnect'] as const)('discards hidden panels on %s without loading hidden snapshots', async reason => {
		const loadTranscriptSnapshot = vi.fn();
		const { cache, registry } = fixture({ loadTranscriptSnapshot });
		const hidden = presentation('chat-view:window-hidden', 'hidden');
		seed(cache, 'hidden');
		registry.reconcile([hidden]);
		const original = registry.panel(hidden.surfaceId)!;
		original.attachPresentation(port({ kind: 'end' }));
		registry.prepareForReconcile([]);
		registry.reconcile([], [hidden]);
		if (reason === 'stale') registry.markChatStale('hidden');
		else if (reason === 'view-replacement') registry.handleViewReplacement('hidden');
		else registry.discardFullscreenHiddenPanels();
		expect(registry.panel(hidden.surfaceId)).toBeNull();
		expect(cache.get('hidden')?.stale).toBe(true);
		expect(loadTranscriptSnapshot).not.toHaveBeenCalled();
		registry.reconcile([], [hidden]);
		expect(registry.panel(hidden.surfaceId)).toBeNull();
		registry.reconcile([hidden]);
		expect(registry.panel(hidden.surfaceId)).not.toBe(original);
		expect(loadTranscriptSnapshot).toHaveBeenCalledOnce();
		registry.destroy();
		cache.flush();
	});

	it('discards a retained panel on a live gap and leaves recovery for reveal', async () => {
		const loadTranscriptSnapshot = vi.fn();
		const { cache, registry } = fixture({ loadTranscriptSnapshot });
		const hidden = presentation('chat-view:window-hidden', 'hidden');
		seed(cache, 'hidden');
		registry.reconcile([hidden]);
		registry.panel(hidden.surfaceId)!.attachPresentation(port({ kind: 'end' }));
		registry.reconcile([], [hidden]);
		expect(registry.applyCommittedBatch({ chatId: 'hidden', transcriptViewId: 'view-1',
			firstOrdinal: 3, lastOrdinal: 3, messages: [message(3)], resendCandidates: [], noticeRevision: 0,
		}).kind).toBe('chat-recovery-required');
		expect(registry.panel(hidden.surfaceId)).toBeNull();
		expect(await registry.loadChatSnapshot('hidden')).toBe(false);
		expect(loadTranscriptSnapshot).not.toHaveBeenCalled();
		registry.reconcile([hidden]);
		expect(loadTranscriptSnapshot).toHaveBeenCalledOnce();
		registry.destroy();
		cache.flush();
	});

	it.each(['host', 'chat', 'tab', 'mobile', 'delete'] as const)('does not retain a fullscreen panel after a %s change', kind => {
		const { cache, registry } = fixture();
		const hidden = presentation('chat-view:window-hidden', 'hidden');
		seed(cache, 'hidden');
		registry.reconcile([hidden]);
		const original = registry.panel(hidden.surfaceId)!;
		original.attachPresentation(port({ kind: 'end' }));
		registry.reconcile([], [hidden]);
		if (kind === 'delete') registry.removeChat('hidden');
		else if (kind === 'tab') registry.reconcile([]);
		else if (kind === 'mobile') registry.reconcile([], [{ ...hidden, presentation: 'mobile', windowId: null }]);
		else if (kind === 'host') registry.reconcile([], [{ ...hidden, presentation: 'window-other', windowId: 'window-other' }]);
		else registry.reconcile([], [{ ...hidden, chatId: 'replacement' }]);
		expect(registry.panel(hidden.surfaceId)).toBeNull();
		registry.destroy();
		cache.flush();
	});

	it('never grants a retained panel composer ownership', () => {
		const hidden = presentation('chat-view:window-hidden', 'hidden');
		const { cache, registry } = fixture({ getSelectedChatId: () => 'hidden', getComposerAnchorSurfaceId: () => hidden.surfaceId });
		seed(cache, 'hidden');
		registry.reconcile([hidden]);
		const original = registry.panel(hidden.surfaceId)!;
		original.attachPresentation(port({ kind: 'end' }));
		expect(registry.composerPanel).toBe(original);
		registry.reconcile([], [hidden]);
		expect(registry.composerPanel).toBeNull();
		registry.reconcile([hidden]);
		expect(registry.composerPanel).toBe(original);
		registry.destroy();
		cache.flush();
	});

	it('protects the entire incoming set before hydrating panels from storage', () => {
		const { cache, registry } = fixture({ maxHiddenEntries: 1 });
		const visible = ['first', 'second', 'third'].map((id) =>
			presentation(`chat-view:window-${id}`, `chat-${id}`),
		);
		try {
			for (const { chatId } of visible) {
				seed(cache, chatId);
				cache.flush();
			}
			expect(cache.get(visible[0]!.chatId)).toBeNull();
			// Hydration runs during reconciliation, before asynchronous snapshot loading.
			registry.reconcile(visible);
			for (const { chatId, surfaceId } of visible) {
				expect(cache.get(chatId)?.messages).toEqual([message(1)]);
				expect(registry.panel(surfaceId)?.transcript.entries).toEqual([message(1)]);
			}
		} finally {
			registry.destroy();
			cache.flush();
		}
	});

	it.each([false, true])(
		'keeps visible chats cached after switching at the window limit (retain inactive: %s)',
		async (retainInactive) => {
			const { cache, registry } = fixture({
				retainInactiveWindows: () => retainInactive,
				loadTranscriptSnapshot: async (transcript, chatId) => {
					seed(cache, chatId);
					transcript.installCachedSnapshot(chatId);
					cache.flush();
				},
			});
			const visible = Array.from({ length: WORKSPACE_WINDOW_RESOURCE_CEILING }, (_, index) =>
				presentation(`chat-view:window-${index}`, `chat-${index}`),
			);
			function applyMessage(chatId: string, ordinal: number) {
				return registry.applyCommittedBatch({
					chatId,
					transcriptViewId: 'view-1',
					messages: [message(ordinal)],
					firstOrdinal: ordinal,
					lastOrdinal: ordinal,
					resendCandidates: [],
					noticeRevision: 0,
				});
			}
			try {
				registry.reconcile(visible);
				await Promise.all(visible.map(({ chatId }) => registry.loadChatSnapshot(chatId)));
				const outgoing = visible[visible.length - 1]!;
				visible[visible.length - 1] = presentation(outgoing.surfaceId, 'chat-new');
				registry.prepareForReconcile(visible);
				registry.reconcile(visible);
				await registry.loadChatSnapshot('chat-new');
				for (const { chatId, surfaceId } of visible) {
					expect(applyMessage(chatId, 2)).toEqual({ kind: 'applied', localRecoverySurfaceIds: [] });
					expect(
						registry.panel(surfaceId)?.transcript.entries.map(({ ordinal }) => ordinal),
					).toEqual([1, 2]);
				}
				for (const ordinal of [2, 3]) {
					expect(applyMessage(outgoing.chatId, ordinal)).toEqual({
						kind: 'applied',
						localRecoverySurfaceIds: [],
					});
				}
				expect(cache.get(outgoing.chatId)?.lastOrdinal).toBe(3);
				expect(registry.hasInactiveWindow(outgoing.chatId)).toBe(retainInactive);
				for (let index = 0; index < CHAT_TRANSCRIPT_CACHE_LIMIT; index += 1) {
					seed(cache, `background-${index}`);
					cache.flush();
				}
				for (let index = 0; index < CHAT_TRANSCRIPT_CACHE_LIMIT; index += 1) {
					expect(cache.get(`background-${index}`)?.lastOrdinal).toBe(1);
				}
				for (const { chatId } of visible) {
					expect(cache.get(chatId)?.lastOrdinal).toBe(2);
				}
				expect(cache.get(outgoing.chatId)).toBeNull();
			} finally {
				registry.destroy();
				cache.flush();
			}
		},
	);

	it.each(['close', 'delete', 'destroy'] as const)(
		'releases visible cache protection on %s without releasing a remaining duplicate',
		(action) => {
			const { cache, registry } = fixture({ maxHiddenEntries: 1 });
			seed(cache);
			const remaining = presentation('chat-view:window-right', 'chat-1');
			registry.reconcile([presentation('chat-view:window-left', 'chat-1'), remaining]);
			registry.reconcile([remaining]);
			seed(cache, 'background');
			seed(cache, 'background-next');
			expect(cache.get('chat-1')).not.toBeNull();
			expect(cache.get('background')).toBeNull();

			switch (action) {
				case 'close':
					registry.reconcile([]);
					break;
				case 'delete':
					registry.removeChat('chat-1');
					expect(cache.get('chat-1')).toBeNull();
					seed(cache);
					break;
				case 'destroy':
					registry.destroy();
					break;
			}
			seed(cache, 'background-new');
			expect(cache.get('chat-1')).toBeNull();
			expect(cache.get('background-new')).not.toBeNull();
			registry.destroy();
			cache.flush();
		},
	);

	it.each([false, true])(
		'keeps moved chats cached while creating a new panel (retain inactive: %s)',
		async (retainInactive) => {
			const { cache, registry } = fixture({
				maxHiddenEntries: 2,
				retainInactiveWindows: () => retainInactive,
				loadTranscriptSnapshot: async (transcript, chatId) => {
					seed(cache, chatId);
					transcript.installCachedSnapshot(chatId);
				},
			});
			seed(cache, 'chat-1');
			seed(cache, 'chat-2');
			registry.reconcile([
				presentation('chat-view:window-left', 'chat-1'),
				presentation('chat-view:window-right', 'chat-2'),
			]);
			seed(cache, 'background-a');
			seed(cache, 'background-b');
			registry
				.prepareChatSurfaceTransfer({
					chatId: 'chat-1',
					sourceSurfaceId: 'chat-view:window-left',
					destinationSurfaceId: 'chat-view:window-right',
				})
				.publish();
			registry.reconcile([
				presentation('chat-view:window-left', 'chat-new'),
				presentation('chat-view:window-right', 'chat-1'),
			]);
			await registry.loadChatSnapshot('chat-new');
			expect(cache.get('chat-1')).not.toBeNull();
			expect(cache.get('chat-2')).toBeNull();
			expect(cache.get('chat-new')).not.toBeNull();
			expect(registry.panel('chat-view:window-right')?.transcript.entries).toEqual([message(1)]);
			registry.destroy();
			cache.flush();
		},
	);

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
		first.revealAllLoadedMessages();
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
		expect(restored?.visibleRows[0]).toMatchObject({ kind: 'message', ordinal: 1 });
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
		first.revealAllLoadedMessages();
		switchPanel(registry, 'chat-2');

		registry.appendServerNotice('chat-1', 'info', 'background notice');
		switchPanel(registry, 'chat-1');

		expect(registry.panel('chat-view:window-left')?.transcript).toBe(first);
		expect(first.visibleRows.find((row) => row.kind === 'message')).toMatchObject({ ordinal: 1 });
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
		right.transcript.visibleMessageCount = 121;
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
		expect(right.transcript.visibleMessageCount).toBe(121);
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

	it.each([
		{ retain: false, reverse: false },
		{ retain: false, reverse: true },
		{ retain: true, reverse: false },
		{ retain: true, reverse: true },
	])(
		'exchanges both Chat reading targets and active intervals: %j',
		async ({ retain, reverse }) => {
			const { cache, registry } = fixture({ retainInactiveWindows: () => retain });
			const ids = ['chat-view:window-left', 'chat-view:window-right'] as const;
			cache.replace('chat-1', 'view-1', [message(1)], 1, null);
			cache.replace('chat-2', 'view-2', [message(1)], 1, null);
			registry.reconcile(ids.map((id, index) => presentation(id, `chat-${index + 1}`)));
			const originals = ids.map((id, index) => {
				const panel = registry.panel(id)!;
				const target = {
					kind: 'row' as const,
					transcriptViewId: `view-${index + 1}`,
					ordinal: 1,
					viewportOffset: -17 - index * 10,
				};
				panel.attachPresentation(port(target));
				if (retain) {
					registry.applyCommittedBatch({
						chatId: panel.chatId,
						transcriptViewId: target.transcriptViewId,
						messages: Array.from({ length: 4_099 }, (_, offset) => message(offset + 2)),
						firstOrdinal: 2,
						lastOrdinal: 4_100,
						resendCandidates: [],
						noticeRevision: 0,
					});
					panel.transcript.revealAllLoadedMessages();
				}
				return { panel, target };
			});
			const publications = ids.map((id, index) =>
				registry.prepareChatSurfaceTransfer({
					sourceSurfaceId: id,
					destinationSurfaceId: ids[1 - index],
					chatId: originals[index].panel.chatId,
				}),
			);
			for (const publication of publications) publication.publish();
			const visible = ids.map((id, index) => presentation(id, originals[1 - index].panel.chatId));
			if (reverse) visible.reverse();
			registry.prepareForReconcile(visible);
			registry.reconcile(visible);
			for (const [index, id] of ids.entries()) {
				const incoming = originals[1 - index];
				const panel = registry.panel(id)!;
				const jump = vi.spyOn(panel.scroll, 'jumpToMessageRow').mockResolvedValue('completed');
				panel.attachPresentation(port({ kind: 'end' }));
				await vi.waitFor(() =>
					expect(jump).toHaveBeenCalledWith(
						{
							chatId: incoming.panel.chatId,
							transcriptViewId: incoming.target.transcriptViewId,
							rowId: `${incoming.target.transcriptViewId}:1`,
						},
						{ viewportOffset: incoming.target.viewportOffset },
					),
				);
				if (retain) {
					expect(panel.transcript).toBe(incoming.panel.transcript);
					expect(panel.transcript.entries).toHaveLength(4_100);
				}
			}
			registry.destroy();
			cache.flush();
		},
	);

	it('preserves pending reading targets across repeated swaps from a hidden source', async () => {
		const { cache, registry } = fixture({ retainInactiveWindows: () => true });
		seed(cache, 'chat-1');
		seed(cache, 'chat-2');
		const left = 'chat-view:window-left';
		const right = 'chat-view:window-right';
		registry.reconcile([presentation(left, 'chat-1'), presentation(right, 'chat-2')]);
		const first = registry.panel(left)!;
		const second = registry.panel(right)!;
		first.attachPresentation(
			port({ kind: 'row', transcriptViewId: 'view-1', ordinal: 1, viewportOffset: -11 }),
		);
		second.attachPresentation(
			port({ kind: 'row', transcriptViewId: 'view-1', ordinal: 1, viewportOffset: -22 }),
		);
		const hidden = [presentation(right, 'chat-2')];
		registry.prepareForReconcile(hidden);
		registry.reconcile(hidden);
		for (const { incoming, outgoing, transcript, viewportOffset } of [
			{
				incoming: 'chat-1',
				outgoing: 'chat-2',
				transcript: first.transcript,
				viewportOffset: -11,
			},
			{
				incoming: 'chat-2',
				outgoing: 'chat-1',
				transcript: second.transcript,
				viewportOffset: -22,
			},
		]) {
			const publications = [
				registry.prepareChatSurfaceTransfer({
					sourceSurfaceId: left,
					destinationSurfaceId: right,
					chatId: incoming,
				}),
				registry.prepareChatSurfaceTransfer({
					sourceSurfaceId: right,
					destinationSurfaceId: left,
					chatId: outgoing,
				}),
			];
			for (const publication of publications) publication.publish();
			const visible = [presentation(right, incoming)];
			registry.prepareForReconcile(visible);
			registry.reconcile(visible);
			const panel = registry.panel(right)!;
			expect(panel.transcript).toBe(transcript);
			const jump = vi.spyOn(panel.scroll, 'jumpToMessageRow').mockResolvedValue('completed');
			panel.attachPresentation(
				port({ kind: 'row', transcriptViewId: 'view-1', ordinal: 1, viewportOffset }),
			);
			await vi.waitFor(() =>
				expect(jump).toHaveBeenCalledWith(
					{ chatId: incoming, transcriptViewId: 'view-1', rowId: 'view-1:1' },
					{ viewportOffset },
				),
			);
		}
		registry.reconcile([presentation(left, 'chat-1'), presentation(right, 'chat-2')]);
		expect(registry.panel(left)?.transcript).toBe(first.transcript);
		registry.destroy();
		cache.flush();
	});

	it.each([false, true])(
		'keeps swapped drafts deferred until admission (retention: %s)',
		async (retain) => {
			const loadTranscriptSnapshot = vi.fn(
				async (transcript: ActiveTranscriptState, chatId: string) => {
					transcript.transcriptCache.replace(chatId, `view-${chatId}`, [message(1)], 1, null);
					transcript.installCachedSnapshot(chatId);
				},
			);
			const { cache, registry } = fixture({
				retainInactiveWindows: () => retain,
				loadTranscriptSnapshot,
			});
			const ids = ['chat-view:window-left', 'chat-view:window-right'] as const;
			registry.reconcile(ids.map((id, index) => presentation(id, `chat-${index + 1}`, 'deferred')));
			const publications = ids.map((id, index) =>
				registry.prepareChatSurfaceTransfer({
					sourceSurfaceId: id,
					destinationSurfaceId: ids[1 - index],
					chatId: `chat-${index + 1}`,
				}),
			);
			for (const publication of publications) publication.publish();
			const swapped = ids.map((id, index) => presentation(id, `chat-${2 - index}`, 'deferred'));
			registry.prepareForReconcile(swapped);
			registry.reconcile(swapped);
			for (const item of swapped) {
				expect(registry.panel(item.surfaceId)?.chatId).toBe(item.chatId);
				await expect(registry.loadChatSnapshot(item.chatId)).resolves.toBe(false);
			}
			expect(loadTranscriptSnapshot).not.toHaveBeenCalled();

			registry.reconcile(swapped.map((item) => ({ ...item, snapshotAdmission: 'admitted' })));

			await vi.waitFor(() => {
				expect(loadTranscriptSnapshot).toHaveBeenCalledTimes(2);
				for (const item of swapped) {
					expect(registry.panel(item.surfaceId)?.transcript.transcriptViewId).toBe(
						`view-${item.chatId}`,
					);
					expect(registry.panel(item.surfaceId)?.transcript.entries).toHaveLength(1);
				}
			});
			registry.destroy();
			cache.flush();
		},
	);

	it.each([false, true])(
		'rejects obsolete refreshes before retrying on swapped transcripts (retention: %s)',
		async (retain) => {
			const originalRelease = deferred<void>();
			const retryRelease = deferred<void>();
			const attempts = new Map<string, number>();
			const outcomes: {
				chatId: string;
				result: ReturnType<ActiveTranscriptState['setFromPage']>;
			}[] = [];
			const loadTranscriptSnapshot = vi.fn(
				async (transcript: ActiveTranscriptState, chatId: string) => {
					const attempt = attempts.get(chatId) ?? 0;
					attempts.set(chatId, attempt + 1);
					const epoch = transcript.beginSnapshotLoad();
					await (attempt === 0 ? originalRelease.promise : retryRelease.promise);
					const lastOrdinal = attempt === 0 ? 1 : 151;
					const result = transcript.setFromPage(
						chatId,
						{
							transcriptViewId: `view-${chatId}`,
							messages: Array.from({ length: lastOrdinal }, (_, index) => message(index + 1)),
							lastOrdinal,
							pageOldestOrdinal: 1,
							pageNewestOrdinal: lastOrdinal,
							nextBeforeOrdinal: null,
							hasMore: false,
							resendCandidates: [],
						},
						epoch,
					);
					outcomes.push({ chatId, result });
				},
			);
			const { cache, registry } = fixture({
				retainInactiveWindows: () => retain,
				loadTranscriptSnapshot,
			});
			const ids = ['chat-view:window-left', 'chat-view:window-right'] as const;
			for (const chatId of ['chat-1', 'chat-2']) {
				cache.replace(chatId, `view-${chatId}`, [message(1)], 1, null);
			}
			registry.reconcile(ids.map((id, index) => presentation(id, `chat-${index + 1}`)));
			const originals = ids.map((id) => registry.panel(id)!);
			for (const panel of originals) {
				registry.applyCommittedBatch({
					chatId: panel.chatId,
					transcriptViewId: `view-${panel.chatId}`,
					messages: Array.from({ length: 149 }, (_, index) => message(index + 2)),
					firstOrdinal: 2,
					lastOrdinal: 150,
					resendCandidates: [],
					noticeRevision: 0,
				});
				panel.transcript.revealAllLoadedMessages();
				expect(panel.transcript.entries).toHaveLength(150);
				expect(cache.get(panel.chatId)?.messages).toHaveLength(100);
			}
			const refreshing = Promise.all(
				originals.map((panel) => registry.loadChatSnapshot(panel.chatId, { minimumLimit: 200 })),
			);
			await vi.waitFor(() => expect(loadTranscriptSnapshot).toHaveBeenCalledTimes(2));
			const publications = ids.map((id, index) =>
				registry.prepareChatSurfaceTransfer({
					sourceSurfaceId: id,
					destinationSurfaceId: ids[1 - index],
					chatId: `chat-${index + 1}`,
				}),
			);
			for (const publication of publications) publication.publish();
			const swapped = ids.map((id, index) => presentation(id, `chat-${2 - index}`));
			registry.prepareForReconcile(swapped);
			registry.reconcile(swapped);

			originalRelease.resolve();
			await vi.waitFor(() => expect(loadTranscriptSnapshot).toHaveBeenCalledTimes(4));
			expect(outcomes).toEqual(
				expect.arrayContaining([
					{ chatId: 'chat-1', result: 'stale' },
					{ chatId: 'chat-2', result: 'stale' },
				]),
			);
			expect(outcomes).toHaveLength(2);
			if (retain) {
				for (const [index, item] of swapped.entries()) {
					const transcript = registry.panel(item.surfaceId)!.transcript;
					expect(transcript).toBe(originals[1 - index].transcript);
					expect(transcript.entries).toHaveLength(150);
					expect(transcript.entries[0].ordinal).toBe(1);
				}
			}

			retryRelease.resolve();
			await expect(refreshing).resolves.toEqual([true, true]);
			for (const item of swapped) {
				await vi.waitFor(() => {
					const panel = registry.panel(item.surfaceId)!;
					expect(panel.chatId).toBe(item.chatId);
					expect(panel.transcript.transcriptViewId).toBe(`view-${item.chatId}`);
					expect(panel.transcript.lastOrdinal).toBe(151);
				});
			}
			for (const [index, item] of swapped.entries()) {
				expect(registry.panel(item.surfaceId)).not.toBe(originals[index]);
				registry.applyCommittedBatch({
					chatId: item.chatId,
					transcriptViewId: `view-${item.chatId}`,
					messages: [message(152)],
					firstOrdinal: 152,
					lastOrdinal: 152,
					resendCandidates: [],
					noticeRevision: 0,
				});
				expect(registry.panel(item.surfaceId)?.transcript.lastOrdinal).toBe(152);
				expect(registry.panel(swapped[1 - index].surfaceId)?.transcript.lastOrdinal).toBe(
					index === 0 ? 151 : 152,
				);
			}
			registry.destroy();
			cache.flush();
		},
	);

	it.each([
		{ rollback: 'replacement', chatId: 'chat-1', viewportOffset: -11 },
		{ rollback: 'superseded', chatId: 'chat-2', viewportOffset: -22 },
	])(
		'preserves the correct pending transfer when the $rollback publication rolls back',
		async ({ rollback, chatId, viewportOffset }) => {
			const { cache, registry } = fixture();
			seed(cache, 'chat-1');
			seed(cache, 'chat-2');
			registry.reconcile([
				presentation('chat-view:window-left', 'chat-1'),
				presentation('chat-view:window-right', 'chat-2'),
			]);
			registry
				.panel('chat-view:window-left')!
				.attachPresentation(
					port({ kind: 'row', transcriptViewId: 'view-1', ordinal: 1, viewportOffset: -11 }),
				);
			registry
				.panel('chat-view:window-right')!
				.attachPresentation(
					port({ kind: 'row', transcriptViewId: 'view-1', ordinal: 1, viewportOffset: -22 }),
				);
			const original = registry.prepareChatSurfaceTransfer({
				sourceSurfaceId: 'chat-view:window-left',
				destinationSurfaceId: 'chat-view:window-hidden',
				chatId: 'chat-1',
			});
			original.publish();
			const replacement = registry.prepareChatSurfaceTransfer({
				sourceSurfaceId: 'chat-view:window-right',
				destinationSurfaceId: 'chat-view:window-hidden',
				chatId: 'chat-2',
			});
			replacement.publish();
			if (rollback === 'replacement') replacement.rollback();
			else original.rollback();
			registry.reconcile([presentation('chat-view:window-hidden', chatId)]);
			const panel = registry.panel('chat-view:window-hidden')!;
			const jump = vi.spyOn(panel.scroll, 'jumpToMessageRow').mockResolvedValue('completed');
			panel.attachPresentation(port({ kind: 'end' }));
			await vi.waitFor(() =>
				expect(jump).toHaveBeenCalledWith(
					{ chatId, transcriptViewId: 'view-1', rowId: 'view-1:1' },
					{ viewportOffset },
				),
			);
			registry.destroy();
			cache.flush();
		},
	);

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
		source.transcript.revealAllLoadedMessages();
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
		source.transcript.revealAllLoadedMessages();
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
		source.transcript.revealAllLoadedMessages();
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
