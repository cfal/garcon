import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DisplayOpenResponse } from '$shared/transcript-display-open';
import { DisplayBodyStore } from '$lib/chat/transcript/display-body-store';
import { ConversationTranscriptOverlayStore } from '$lib/chat/transcript/conversation-transcript-overlay-store.svelte';
import { displayOpen, displayRow, mockDisplayApi } from '$lib/chat/transcript/__tests__/display-fixtures';
import type { ChatViewSurfaceId } from '$lib/workspace/surface-types';
import { ConversationLifecycleState } from '../conversation-lifecycle-state.svelte';
import {
	ConversationPanelRegistry,
	type ConversationPanelDescriptor,
	type ConversationPanelPresentationPort,
} from '../conversation-panel-registry.svelte';

const surfaces = ['chat-view:window-left', 'chat-view:window-right'] as const;
const chats = ['chat-1', 'chat-2'] as const;
const registries: ConversationPanelRegistry[] = [];

afterEach(() => {
	for (const registry of registries.splice(0)) registry.destroy();
	vi.restoreAllMocks();
});

function presentation(
	surfaceId: ChatViewSurfaceId,
	chatId: string,
	snapshotAdmission: 'admitted' | 'deferred' = 'admitted',
): ConversationPanelDescriptor {
	const windowId = surfaceId.slice('chat-view:'.length) as `window-${string}`;
	return { surfaceId, chatId, windowId, presentation: windowId, snapshotAdmission };
}

function port(target: ReturnType<ConversationPanelPresentationPort['captureRestoreTarget']>): ConversationPanelPresentationPort {
	return {
		getScrollContainer: () => null,
		getViewport: () => null,
		getQueueContainer: () => undefined,
		captureRestoreTarget: () => target,
		closeTransients: vi.fn(),
	};
}

function fixture(retain: boolean, head = 1) {
	const api = mockDisplayApi();
	const replaceChat = (chatId: string, sourceHead: number) => api.replace(
		Array.from({ length: sourceHead }, (_, index) => displayRow(index + 1)),
		displayOpen(chatId, `view-${chatId}`, sourceHead),
	);
	for (const chatId of chats) replaceChat(chatId, head);
	const lifecycles = new Map<string, ConversationLifecycleState>();
	const onOpen = vi.fn();
	const registry = new ConversationPanelRegistry({
		bodies: new DisplayBodyStore(),
		overlays: new ConversationTranscriptOverlayStore(),
		onOpen,
		lifecycle: {
			forChat(chatId) {
				let lifecycle = lifecycles.get(chatId);
				if (!lifecycle) {
					lifecycle = new ConversationLifecycleState();
					lifecycle.setCurrentChatId(chatId);
					lifecycles.set(chatId, lifecycle);
				}
				return lifecycle;
			},
			remove: chatId => { lifecycles.delete(chatId); },
		},
		getComposerAnchorSurfaceId: () => surfaces[0],
		getSelectedChatId: () => chats[0],
		retainInactiveWindows: () => retain,
	});
	registries.push(registry);
	return { api, registry, replaceChat, onOpen };
}

function publishSwap(registry: ConversationPanelRegistry, currentChats: readonly [string, string] = chats) {
	const publications = surfaces.map((sourceSurfaceId, index) => registry.prepareChatSurfaceTransfer({
		sourceSurfaceId,
		destinationSurfaceId: surfaces[1 - index],
		chatId: currentChats[index],
	}));
	for (const publication of publications) publication.publish();
	return surfaces.map((surfaceId, index) => presentation(surfaceId, currentChats[1 - index]));
}

describe('certified display windows across Chat swaps', () => {
	it.each([
		{ retain: false, reverse: false },
		{ retain: false, reverse: true },
		{ retain: true, reverse: false },
		{ retain: true, reverse: true },
	])('exchanges reading targets and bounded resident windows: %j', async ({ retain, reverse }) => {
		const { registry } = fixture(retain, 4_100);
		registry.reconcile(surfaces.map((surfaceId, index) => presentation(surfaceId, chats[index])));
		await Promise.all(chats.map(chatId => registry.loadChatSnapshot(chatId)));
		const originals = surfaces.map((surfaceId, index) => {
			const panel = registry.panel(surfaceId)!;
			const target = {
				kind: 'row' as const,
				transcriptViewId: `view-${chats[index]}`,
				ordinal: 4_075 + index,
				viewportOffset: -17 - index * 10,
			};
			panel.attachPresentation(port(target));
			expect(panel.transcript.entries).toHaveLength(50);
			return { panel, target, window: panel.transcript.display.window };
		});
		const swapped = publishSwap(registry);
		if (reverse) swapped.reverse();
		registry.prepareForReconcile(swapped);
		registry.reconcile(swapped);
		for (const [index, surfaceId] of surfaces.entries()) {
			const incoming = originals[1 - index];
			const panel = registry.panel(surfaceId)!;
			if (retain) {
				expect(panel.transcript).toBe(incoming.panel.transcript);
				expect(panel.transcript.display.window).toBe(incoming.window);
			}
			const jump = vi.spyOn(panel.scroll, 'jumpToMessageRow').mockResolvedValue('completed');
			panel.attachPresentation(port({ kind: 'end' }));
			await vi.waitFor(() => expect(jump).toHaveBeenCalledWith(
				{
					chatId: incoming.panel.chatId,
					transcriptViewId: incoming.target.transcriptViewId,
					rowId: `${incoming.target.transcriptViewId}:${incoming.target.ordinal}`,
				},
				{ viewportOffset: incoming.target.viewportOffset },
			));
			expect(panel.transcript.entries.some(row => row.ordinal === incoming.target.ordinal)).toBe(true);
			expect(panel.transcript.entries).toHaveLength(50);
		}
	});

	it('preserves pending reading targets across repeated swaps from a hidden source', async () => {
		const { registry } = fixture(true);
		registry.reconcile(surfaces.map((surfaceId, index) => presentation(surfaceId, chats[index])));
		await Promise.all(chats.map(chatId => registry.loadChatSnapshot(chatId)));
		const originals = surfaces.map((surfaceId, index) => {
			const panel = registry.panel(surfaceId)!;
			panel.attachPresentation(port({
				kind: 'row', transcriptViewId: `view-${chats[index]}`, ordinal: 1, viewportOffset: -11 * (index + 1),
			}));
			return panel;
		});
		const hidden = [presentation(surfaces[1], chats[1])];
		registry.prepareForReconcile(hidden);
		registry.reconcile(hidden);
		for (const index of [0, 1]) {
			const incoming = chats[index];
			publishSwap(registry, [incoming, chats[1 - index]]);
			const visible = [presentation(surfaces[1], incoming)];
			registry.prepareForReconcile(visible);
			registry.reconcile(visible);
			const panel = registry.panel(surfaces[1])!;
			expect(panel.transcript).toBe(originals[index].transcript);
			const jump = vi.spyOn(panel.scroll, 'jumpToMessageRow').mockResolvedValue('completed');
			const viewportOffset = -11 * (index + 1);
			panel.attachPresentation(port({ kind: 'row', transcriptViewId: `view-${incoming}`, ordinal: 1, viewportOffset }));
			await vi.waitFor(() => expect(jump).toHaveBeenCalledWith(
				{ chatId: incoming, transcriptViewId: `view-${incoming}`, rowId: `view-${incoming}:1` },
				{ viewportOffset },
			));
		}
		registry.reconcile(surfaces.map((surfaceId, index) => presentation(surfaceId, chats[index])));
		expect(registry.panel(surfaces[0])?.transcript).toBe(originals[0].transcript);
	});

	it.each([false, true])('keeps swapped drafts deferred until admission (retention: %s)', async retain => {
		const { api, registry } = fixture(retain);
		registry.reconcile(surfaces.map((surfaceId, index) => presentation(surfaceId, chats[index], 'deferred')));
		const swapped = publishSwap(registry).map(item => ({ ...item, snapshotAdmission: 'deferred' as const }));
		registry.prepareForReconcile(swapped);
		registry.reconcile(swapped);
		for (const item of swapped) {
			expect(registry.panel(item.surfaceId)?.chatId).toBe(item.chatId);
			expect(await registry.loadChatSnapshot(item.chatId)).toBe(false);
		}
		expect(api.open).not.toHaveBeenCalled();
		registry.reconcile(swapped.map(item => ({ ...item, snapshotAdmission: 'admitted' })));
		await vi.waitFor(() => {
			expect(api.open).toHaveBeenCalledTimes(2);
			for (const item of swapped) {
				expect(registry.panel(item.surfaceId)?.transcript.transcriptViewId).toBe(`view-${item.chatId}`);
				expect(registry.panel(item.surfaceId)?.transcript.entries).toHaveLength(1);
			}
		});
	});

	it.each([false, true])('keeps compatible chat opens through a swap (retention: %s)', async retain => {
		const { api, registry, replaceChat, onOpen } = fixture(retain, 150);
		registry.reconcile(surfaces.map((surfaceId, index) => presentation(surfaceId, chats[index])));
		await Promise.all(chats.map(chatId => registry.loadChatSnapshot(chatId)));
		const held = new Map(chats.map(chatId => [chatId, Promise.withResolvers<DisplayOpenResponse>()]));
		api.open.mockClear().mockImplementation(request => held.get(request.chatId as typeof chats[number])!.promise);
		onOpen.mockClear();
		const refreshing = Promise.all(chats.map(chatId => registry.loadChatSnapshot(chatId, { purpose: 'activation' })));
		await vi.waitFor(() => expect(api.open).toHaveBeenCalledTimes(2));
		const swapped = publishSwap(registry);
		registry.prepareForReconcile(swapped);
		registry.reconcile(swapped);
		for (const [, options] of api.open.mock.calls) expect(options?.signal?.aborted).toBe(false);
		for (const chatId of chats) {
			replaceChat(chatId, 151);
			held.get(chatId)!.resolve(displayOpen(chatId, `view-${chatId}`, 151));
		}
		expect(await refreshing).toEqual([true, true]);
		expect(api.open).toHaveBeenCalledTimes(2);
		expect(onOpen).toHaveBeenCalledTimes(2);
		for (const item of swapped) {
			await vi.waitFor(() => {
				const transcript = registry.panel(item.surfaceId)!.transcript;
				expect(transcript.transcriptViewId).toBe(`view-${item.chatId}`);
				expect(transcript.loadedThroughOrdinal).toBe(151);
			});
		}
		replaceChat(chats[0], 152);
		registry.observeHead(chats[0], `view-${chats[0]}`, 152);
		expect(registry.panel(surfaces[1])!.transcript.lastOrdinal).toBe(152);
		expect(registry.panel(surfaces[0])!.transcript.lastOrdinal).toBe(151);
	});

	it.each([false, true])('fences held surface reads without rolling back swapped windows (retention: %s)', async retain => {
		const { api, registry, replaceChat } = fixture(retain, 150);
		registry.reconcile(surfaces.map((surfaceId, index) => presentation(surfaceId, chats[index])));
		await Promise.all(chats.map(chatId => registry.loadChatSnapshot(chatId)));
		const holds = chats.map(() => ({ ready: Promise.withResolvers<void>(), release: Promise.withResolvers<void>() }));
		const pending = new Map<string, typeof holds[number]>(chats.map((chatId, index) => [chatId, holds[index]]));
		const signals = new Map<string, AbortSignal | undefined>();
		const windowImpl = api.window.getMockImplementation()!;
		api.window.mockImplementation(async (request, options) => {
			const hold = pending.get(request.chatId);
			pending.delete(request.chatId);
			const result = await windowImpl(request, options);
			if (hold) {
				signals.set(request.chatId, options?.signal);
				hold.ready.resolve();
				await hold.release.promise;
			}
			return result;
		});
		const refreshing = surfaces.map(surfaceId => registry.panel(surfaceId)!.transcript.controller.refresh());
		await Promise.all(holds.map(hold => hold.ready.promise));
		for (const chatId of chats) replaceChat(chatId, 151);
		const swapped = publishSwap(registry);
		registry.prepareForReconcile(swapped);
		registry.reconcile(swapped);
		for (const chatId of chats) expect(signals.get(chatId)?.aborted).toBe(true);
		for (const hold of holds) hold.release.resolve();
		await Promise.all(refreshing);
		await vi.waitFor(() => {
			for (const item of swapped) {
				const transcript = registry.panel(item.surfaceId)!.transcript;
				expect(transcript.display.window?.certificate).toMatchObject({
					chatId: item.chatId, transcriptViewId: `view-${item.chatId}`, watermark: 151,
				});
				expect(transcript.entries.at(-1)?.ordinal).toBe(151);
			}
		});
	});

	it.each([
		{ rollback: 'replacement', chatId: chats[0], viewportOffset: -11 },
		{ rollback: 'superseded', chatId: chats[1], viewportOffset: -22 },
	])('preserves the pending target when the $rollback transfer rolls back', async ({ rollback, chatId, viewportOffset }) => {
		const { registry } = fixture(true);
		registry.reconcile(surfaces.map((surfaceId, index) => presentation(surfaceId, chats[index])));
		await Promise.all(chats.map(id => registry.loadChatSnapshot(id)));
		for (const [index, surfaceId] of surfaces.entries()) {
			registry.panel(surfaceId)!.attachPresentation(port({
				kind: 'row', transcriptViewId: `view-${chats[index]}`, ordinal: 1, viewportOffset: -11 * (index + 1),
			}));
		}
		const destinationSurfaceId = 'chat-view:window-hidden';
		const original = registry.prepareChatSurfaceTransfer({ sourceSurfaceId: surfaces[0], destinationSurfaceId, chatId: chats[0] });
		original.publish();
		const replacement = registry.prepareChatSurfaceTransfer({ sourceSurfaceId: surfaces[1], destinationSurfaceId, chatId: chats[1] });
		replacement.publish();
		if (rollback === 'replacement') replacement.rollback();
		else original.rollback();
		registry.reconcile([presentation(destinationSurfaceId, chatId)]);
		const panel = registry.panel(destinationSurfaceId)!;
		const jump = vi.spyOn(panel.scroll, 'jumpToMessageRow').mockResolvedValue('completed');
		panel.attachPresentation(port({ kind: 'end' }));
		await vi.waitFor(() => expect(jump).toHaveBeenCalledWith(
			{ chatId, transcriptViewId: `view-${chatId}`, rowId: `view-${chatId}:1` },
			{ viewportOffset },
		));
	});
});
