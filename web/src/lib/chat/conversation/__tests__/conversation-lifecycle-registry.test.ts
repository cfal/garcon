import { describe, expect, it, vi } from 'vitest';
import { ConversationLifecycleRegistry } from '../conversation-lifecycle-registry.svelte.js';
import type {
	ChatProcessingPresentation,
	ChatProcessingPresentationRegistry,
} from '$lib/ws/chat-processing-reconciler.svelte.js';

function makeRegistry(phases: Record<string, 'running' | 'stopping' | null> = {}) {
	let presentation: ChatProcessingPresentation | null = null;
	const processing: ChatProcessingPresentationRegistry = {
		addPresentation(next) {
			presentation = next;
			return () => {
				if (presentation === next) presentation = null;
			};
		},
	};
	const clearTurnPermissionRequestsForChat = vi.fn();
	const registry = new ConversationLifecycleRegistry({
		sessions: {
			processingPhase: (chatId) => phases[chatId] ?? null,
		},
		processing,
		conversationUi: { clearTurnPermissionRequestsForChat },
	});
	return {
		registry,
		presentation: () => {
			if (!presentation) throw new Error('Processing presentation is not registered');
			return presentation;
		},
		clearTurnPermissionRequestsForChat,
	};
}

describe('ConversationLifecycleRegistry', () => {
	it('shares one lifecycle value for duplicate presentations of a chat', () => {
		const { registry } = makeRegistry({ 'chat-a': 'running' });

		const first = registry.forChat('chat-a');
		const second = registry.forChat('chat-a');

		expect(second).toBe(first);
		expect(first.currentChatId).toBe('chat-a');
		expect(first.turnStatus).toBe('running');
	});

	it('keeps chat transitions and stopping rollback independent', () => {
		const { registry } = makeRegistry();
		registry.beginTurn('chat-a');
		registry.beginTurn('chat-b');
		const snapshot = registry.beginStopping('chat-a', 'stop-a');

		expect(registry.forChat('chat-a').turnStatus).toBe('stopping');
		expect(registry.forChat('chat-b').turnStatus).toBe('running');

		registry.restoreStopping('chat-a', 'stop-a', snapshot);

		expect(registry.forChat('chat-a').turnStatus).toBe('running');
		expect(registry.forChat('chat-b').turnStatus).toBe('running');
	});

	it('routes processing reconciliation by chat and prunes removed chats', () => {
		const { registry, presentation, clearTurnPermissionRequestsForChat } = makeRegistry();
		registry.forChat('chat-a');
		registry.forChat('chat-b');

		presentation().applyProcessingPhase('chat-b', 'stopping');
		presentation().applyProcessingPhase('chat-b', null);
		presentation().clearTurnPermissionRequests('chat-b');
		registry.prune(new Set(['chat-a']));

		expect(registry.forChat('chat-a').turnStatus).toBe('idle');
		expect(registry.get('chat-b')).toBeNull();
		expect(clearTurnPermissionRequestsForChat).toHaveBeenCalledWith('chat-b');
	});
});
