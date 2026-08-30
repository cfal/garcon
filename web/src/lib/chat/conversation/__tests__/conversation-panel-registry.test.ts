import { describe, expect, it, vi } from 'vitest';
import { AssistantMessage } from '$shared/chat-types';
import type { TranscriptMessage } from '$shared/chat-view';
import { ChatTranscriptCache } from '$lib/chat/transcript/chat-transcript-cache.svelte.js';
import { ConversationTranscriptOverlayStore } from '$lib/chat/transcript/conversation-transcript-overlay-store.svelte.js';
import { ConversationLifecycleState } from '../conversation-lifecycle-state.svelte.js';
import {
	ConversationPanelRegistry,
	type ConversationPanelPresentationPort,
} from '../conversation-panel-registry.svelte.js';
import type { VisibleChatPresentation } from '$lib/workspace/visible-presentations.js';

function message(ordinal: number): TranscriptMessage {
	return {
		ordinal,
		message: new AssistantMessage('2026-08-30T00:00:00.000Z', `message-${ordinal}`),
	};
}

function presentation(
	surfaceId: `chat-view:window-${string}`,
	chatId: string,
	isCurrent = false,
): VisibleChatPresentation {
	const windowId = surfaceId.slice('chat-view:'.length) as `window-${string}`;
	return { surfaceId, chatId, presentation: windowId, windowId, isCurrent };
}

function fixture() {
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
	const registry = new ConversationPanelRegistry({ cache, overlays, lifecycle });
	return { cache, overlays, lifecycles, registry };
}

function seed(cache: ChatTranscriptCache, chatId = 'chat-1'): void {
	cache.replace(chatId, 'view-1', [message(1)], 1, null);
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

	it('rekeys only the explicit transfer source when duplicate chats exist', () => {
		const { cache, registry } = fixture();
		seed(cache);
		registry.reconcile([
			presentation('chat-view:window-left', 'chat-1', true),
			presentation('chat-view:window-right', 'chat-1'),
		]);
		const source = registry.panel('chat-view:window-left');
		const duplicate = registry.panel('chat-view:window-right');
		const transfer = registry.prepareSurfaceTransfers([
			{
				from: 'chat-view:window-left',
				to: 'chat-view:window-third',
				chatId: 'chat-1',
			},
		]);

		transfer.commit();

		expect(registry.panel('chat-view:window-left')).toBeNull();
		expect(registry.panel('chat-view:window-third')).toBe(source);
		expect(registry.panel('chat-view:window-right')).toBe(duplicate);
		cache.flush();
	});

	it('leaves registry ownership unchanged when a prepared transfer aborts', () => {
		const { cache, registry } = fixture();
		seed(cache);
		registry.reconcile([presentation('chat-view:window-left', 'chat-1', true)]);
		const source = registry.panel('chat-view:window-left');
		const transfer = registry.prepareSurfaceTransfers([
			{
				from: 'chat-view:window-left',
				to: 'chat-view:window-right',
				chatId: 'chat-1',
			},
		]);

		transfer.abort();

		expect(registry.panel('chat-view:window-left')).toBe(source);
		expect(registry.panel('chat-view:window-right')).toBeNull();
		cache.flush();
	});
});
