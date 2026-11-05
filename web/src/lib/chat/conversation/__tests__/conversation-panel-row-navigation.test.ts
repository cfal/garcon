import { afterEach, expect, it, vi } from 'vitest';
import { tick } from 'svelte';
import { AssistantMessage } from '$shared/chat-types';
import type { AvailableDisplayWindow } from '$shared/transcript-display-contract';
import type { DisplayOpenResponse } from '$shared/transcript-display-open';
import { DisplayBodyStore } from '$lib/chat/transcript/display-body-store.js';
import { displayOpen, displayCertificate, displayWindow, mockDisplayApi } from '$lib/chat/transcript/__tests__/display-fixtures.js';
import { ConversationTranscriptOverlayStore } from '$lib/chat/transcript/conversation-transcript-overlay-store.svelte.js';
import type { ConversationViewportPort } from '$lib/chat/transcript/conversation-viewport-port.js';
import { ConversationLifecycleState } from '../conversation-lifecycle-state.svelte.js';
import { ConversationPanelRegistry } from '../conversation-panel-registry.svelte.js';

const chatId = '1000000000000001';
const target = { chatId, transcriptViewId: 'view-1', ordinal: 100 };
const row = (ordinal: number) => ({
	ordinal,
	message: new AssistantMessage('2026-01-01T00:00:00.000Z', `Synthetic row ${ordinal}`),
});
function page(): AvailableDisplayWindow {
	return displayWindow([{ kind: 'row', ordinal: 100, messageType: 'assistant-message', layout: 'standard',
		estimatedBodyBytes: 100, permissionOccurrenceId: null }], displayCertificate(displayOpen(chatId, 'view-1', 1000)));
}
const rows = Array.from({ length: 1000 }, (_, index) => row(index + 1));
function snapshotPage(view = 'view-1') { return displayOpen(chatId, view, 1000); }
function held<T>() {
	let release!: (value: T) => void;
	const promise = new Promise<T>((resolve) => {
		release = resolve;
	});
	return { promise, release };
}
const cleanup: (() => void)[] = [];
afterEach(() => {
	for (const fn of cleanup.splice(0)) fn();
	vi.restoreAllMocks();
});
async function fixture() {
	const api = mockDisplayApi(rows, snapshotPage());
	const registry = new ConversationPanelRegistry({
		bodies: new DisplayBodyStore(),
		overlays: new ConversationTranscriptOverlayStore(),
		lifecycle: { forChat: () => new ConversationLifecycleState(), remove: () => {} },
		getComposerAnchorSurfaceId: () => 'chat-view:window-one',
		getSelectedChatId: () => chatId,
	});
	cleanup.push(() => registry.destroy());
	registry.reconcile([
		{
			surfaceId: 'chat-view:window-one',
			windowId: 'window-one',
			presentation: 'window-one',
			chatId,
			snapshotAdmission: 'admitted',
		},
	]);
	const panel = registry.panel('chat-view:window-one')!;
	await registry.loadChatSnapshot(chatId);
	api.open.mockClear(); api.window.mockClear();
	const viewport = {
		requestCoverage: vi.fn(),
		isReady: () => true,
		hasCollapsedToolGroups: () => false,
		isAtEnd: () => false,
		ownsScrollPosition: () => false,
		viewportPosition: () => ({
			logicalOffset: 100,
			distanceFromStart: 100,
			leadingContentReachable: true,
		}),
		scrollToStart: vi.fn(),
		scrollToEnd: vi.fn(),
		restoreInitialEnd: vi.fn(),
		scrollBy: vi.fn(),
		waitForLayout: vi.fn(async () => 'settled' as const),
		measureViewportFill: vi.fn(async () => 'underfilled' as const),
		restoreHiddenReadingPosition: vi.fn(async () => 'restored' as const),
		cancelPendingLayoutMutation: vi.fn(),
		cancelForUserIntent: vi.fn(() => 'cancelled' as const),
		setNativeScrollActivity: vi.fn(),
		scrollToTarget: vi.fn<ConversationViewportPort['scrollToTarget']>(async () => 'completed'),
	} satisfies ConversationViewportPort;
	let attachedViewport: ConversationViewportPort | null = null;
	panel.attachPresentation({
		getScrollContainer: () => null,
		getViewport: () => attachedViewport,
		getQueueContainer: () => undefined,
		captureRestoreTarget: () => null,
		closeTransients: () => {},
	});
	return {
		registry,
		api,
		panel,
		viewport,
		attach: () => {
			attachedViewport = viewport;
			panel.resumePendingRestore();
		},
	};
}

it('waits for the exact renderer viewport, supersedes bottom restore, and loads one page without autofill', async () => {
	const f = await fixture();
	f.api.window.mockResolvedValue(page());
	const work = f.panel.navigateToTranscriptRow(target, new AbortController().signal, () => true);
	await tick();
	expect(f.api.window).not.toHaveBeenCalled();
	f.attach();
	expect(await work).toBe('completed');
	expect(f.viewport.scrollToTarget).toHaveBeenCalledExactlyOnceWith(
		{ kind: 'row', id: 'view-1:100' },
		{ align: 'center' },
	);
	expect(f.viewport.scrollToEnd).not.toHaveBeenCalled();
	expect(f.viewport.measureViewportFill).not.toHaveBeenCalled();
	expect(f.api.window).toHaveBeenCalledOnce();
});

it('keeps the restore anchor through actual viewport positioning and profile cancellation', async () => {
	const f = await fixture();
	f.attach();
	const positioned = held<'completed'>();
	f.viewport.scrollToTarget.mockReturnValueOnce(positioned.promise);
	const restoring = f.panel.restore({ kind: 'row', transcriptViewId: 'view-1', ordinal: 100, viewportOffset: -12 });
	await vi.waitFor(() => expect(f.viewport.scrollToTarget).toHaveBeenCalledOnce());
	f.panel.transcript.configureDisplay({ combine: true, showThinking: false, hiddenToolGroups: [] });
	f.panel.transcript.controller.setReadingAnchor(700, false);
	await f.panel.transcript.controller.refresh();
	expect(f.api.window.mock.calls.at(-1)![0].anchor).toEqual({ kind: 'around', ordinal: 100 });
	positioned.release('completed');
	await restoring;
	f.panel.transcript.controller.setReadingAnchor(700, false);
	await f.panel.transcript.controller.refresh();
	expect(f.api.window.mock.calls.at(-1)![0].anchor).toEqual({ kind: 'around', ordinal: 700 });
});

it('a user scroll supersedes historical restoration while activation is held', async () => {
	const f = await fixture();
	f.attach();
	const opened = held<DisplayOpenResponse>();
	f.api.open.mockReturnValueOnce(opened.promise);
	const restoring = f.panel.restore({ kind: 'row', transcriptViewId: 'view-1', ordinal: 100, viewportOffset: -12 });
	f.panel.scroll.noteUserScrollIntent('earlier');
	opened.release(snapshotPage());
	await restoring;
	expect(f.viewport.scrollToTarget).not.toHaveBeenCalled();
	f.panel.transcript.controller.setReadingAnchor(700, false);
	await f.panel.transcript.controller.refresh();
	expect(f.api.window.mock.calls.at(-1)![0].anchor).toEqual({ kind: 'around', ordinal: 700 });
});

it('releases a restore target that is absent from a ready filtered viewport', async () => {
	const f = await fixture();
	f.attach();
	f.viewport.scrollToTarget.mockResolvedValue('target-missing');
	await f.panel.restore({ kind: 'row', transcriptViewId: 'view-1', ordinal: 100, viewportOffset: -12 });
	expect(f.viewport.scrollToTarget).toHaveBeenCalledOnce();
	f.panel.resumePendingRestore();
	await tick();
	expect(f.viewport.scrollToTarget).toHaveBeenCalledOnce();
	f.panel.transcript.controller.setReadingAnchor(700, false);
	await f.panel.transcript.controller.refresh();
	expect(f.api.window.mock.calls.at(-1)![0].anchor).toEqual({ kind: 'around', ordinal: 700 });
	expect(f.panel.scroll.isPinnedToBottom).toBe(false);
});

it('retains reload identity if the view changes while the target page is held', async () => {
	const f = await fixture();
	f.attach();
	const response = held<AvailableDisplayWindow>();
	f.api.window.mockReturnValue(response.promise);
	const work = f.panel.navigateToTranscriptRow(target, new AbortController().signal, () => true);
	await vi.waitFor(() => expect(f.api.window).toHaveBeenCalledOnce());
	f.panel.transcript.installOpen(snapshotPage('view-2'));
	response.release(page());
	expect(await work).toBe('view-changed');
	expect(f.viewport.scrollToTarget).not.toHaveBeenCalled();
});

it.each(['hide', 'interaction', 'supersede'] as const)(
	'cancels a held target page on %s without overwriting or scrolling',
	async (change) => {
		const f = await fixture();
		f.attach();
		const response = held<AvailableDisplayWindow>();
		f.api.window.mockReturnValueOnce(response.promise).mockResolvedValue(page());
		const work = f.panel.navigateToTranscriptRow(target, new AbortController().signal, () => true);
		await vi.waitFor(() => expect(f.api.window).toHaveBeenCalledOnce());
		if (change === 'hide') f.panel.prepareForHide();
		if (change === 'interaction') f.panel.prepareForInteractionLoss();
		if (change === 'supersede')
			expect(
				await f.panel.navigateToTranscriptRow(target, new AbortController().signal, () => true),
			).toBe('completed');
		response.release(page());
		expect(await work).toBe('cancelled');
		expect(f.viewport.scrollToTarget).toHaveBeenCalledTimes(change === 'supersede' ? 1 : 0);
		expect(f.api.window.mock.calls[0]?.[1]?.aborted).toBe(true);
	},
);

it('aborts an in-progress viewport target without resetting another navigation', async () => {
	const f = await fixture();
	f.attach();
	f.api.window.mockResolvedValue(page());
	const scroll = held<'completed'>();
	f.viewport.scrollToTarget.mockReturnValueOnce(scroll.promise);
	const abort = new AbortController();
	const work = f.panel.navigateToTranscriptRow(target, abort.signal, () => true);
	await vi.waitFor(() => expect(f.viewport.scrollToTarget).toHaveBeenCalledOnce());
	abort.abort();
	expect(f.viewport.cancelPendingLayoutMutation).toHaveBeenCalledOnce();
	scroll.release('completed');
	expect(await work).toBe('cancelled');
});

it('supersedes a saved-row restore before its first layout tick', async () => {
	const f = await fixture();
	f.attach();
	f.api.window.mockResolvedValue(page());
	const restore = f.panel.restore({
		kind: 'row',
		transcriptViewId: 'view-1',
		ordinal: 1000,
		viewportOffset: 0,
	});
	const work = f.panel.navigateToTranscriptRow(target, new AbortController().signal, () => true);
	await restore;
	expect(await work).toBe('completed');
	expect(f.viewport.scrollToTarget).toHaveBeenCalledExactlyOnceWith(
		{ kind: 'row', id: 'view-1:100' },
		{ align: 'center' },
	);
});

it('cancels while the initial open is held without waiting for its response', async () => {
	const f = await fixture(); f.attach();
	const snapshot = held<DisplayOpenResponse>();
	f.api.open.mockReturnValueOnce(snapshot.promise);
	const restore = f.panel.restore(null);
	await vi.waitFor(() => expect(f.api.open).toHaveBeenCalledOnce());
	const abort = new AbortController();
	const work = f.panel.navigateToTranscriptRow(target, abort.signal, () => true);
	abort.abort();
	await expect(work).resolves.toBe('cancelled');
	snapshot.release(snapshotPage()); await restore;
	expect(f.viewport.scrollToTarget).not.toHaveBeenCalled();
});

it('navigates after a failed initial open has been retried successfully', async () => {
	const f = await fixture(); f.attach();
	f.api.open.mockRejectedValueOnce(new Error('Synthetic snapshot failure'));
	await expect(f.panel.restore(null)).rejects.toThrow('Synthetic snapshot failure');
	await expect(f.registry.loadChatSnapshot(chatId)).resolves.toBe(true);
	await expect(f.panel.navigateToTranscriptRow(target, new AbortController().signal, () => true)).resolves.toBe('completed');
	expect(f.viewport.scrollToTarget).toHaveBeenCalledOnce();
});

it('waits for a current reload open and reports the replaced view', async () => {
	const f = await fixture(); f.attach();
	const snapshot = held<DisplayOpenResponse>();
	f.api.open.mockReturnValueOnce(snapshot.promise);
	const reload = f.registry.loadChatSnapshot(chatId);
	const work = f.panel.navigateToTranscriptRow(target, new AbortController().signal, () => true);
	let settled = false; void work.then(() => { settled = true; });
	await tick(); expect(settled).toBe(false);
	f.api.replace(rows, snapshotPage('view-2'));
	snapshot.release(snapshotPage('view-2')); await reload;
	expect(await work).toBe('view-changed');
	expect(f.viewport.scrollToTarget).not.toHaveBeenCalled();
});

it('waits through a purpose-qualified successor open before loading its target', async () => {
	const f = await fixture(); f.attach();
	const first = held<DisplayOpenResponse>(), successor = held<DisplayOpenResponse>();
	f.api.open.mockReturnValueOnce(first.promise).mockReturnValueOnce(successor.promise);
	const background = f.registry.loadChatSnapshot(chatId);
	const activation = f.registry.loadChatSnapshot(chatId, { purpose: 'activation' });
	const work = f.panel.navigateToTranscriptRow(target, new AbortController().signal, () => true);
	first.release(snapshotPage()); await background;
	await vi.waitFor(() => expect(f.api.open).toHaveBeenCalledTimes(2));
	expect(f.viewport.scrollToTarget).not.toHaveBeenCalled();
	successor.release(snapshotPage()); await activation;
	expect(await work).toBe('completed');
});

it.each(['view-1', 'view-2'])('waits for an open in %s that supersedes the target request', async view => {
	const f = await fixture(); f.attach();
	const targetPage = held<AvailableDisplayWindow>(), snapshot = held<DisplayOpenResponse>();
	f.api.window.mockReturnValueOnce(targetPage.promise);
	f.api.open.mockReturnValueOnce(snapshot.promise);
	const work = f.panel.navigateToTranscriptRow(target, new AbortController().signal, () => true);
	await vi.waitFor(() => expect(f.api.window).toHaveBeenCalledOnce());
	const reload = f.registry.loadChatSnapshot(chatId);
	targetPage.release(page()); await tick();
	expect(f.viewport.scrollToTarget).not.toHaveBeenCalled();
	f.api.replace(rows, snapshotPage(view));
	snapshot.release(snapshotPage(view)); await reload;
	expect(await work).toBe(view === 'view-2' ? 'view-changed' : 'cancelled');
});

it.each(['completed', 'unavailable', 'view-changed'] as const)(
	'replaces a stale %s result when interaction is lost during the final snapshot checkpoint',
	async (result) => {
		const f = await fixture();
		f.attach();
		vi.spyOn(f.panel.scroll, 'navigateToTranscriptRow').mockResolvedValue(result);
		const ownsNavigation = () => {
			queueMicrotask(() => f.panel.prepareForInteractionLoss());
			return true;
		};
		expect(
			await f.panel.navigateToTranscriptRow(target, new AbortController().signal, ownsNavigation),
		).toBe('cancelled');
	},
);
