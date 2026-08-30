import type { ChatProcessingPhase } from '$shared/chat-types';
import type { ChatSessionsPort } from '$lib/chat/sessions/chat-sessions.svelte.js';
import type { ConversationUiPort } from './conversation-ui-state.svelte.js';
import {
	ConversationLifecycleState,
	type StoppingSnapshot,
} from './conversation-lifecycle-state.svelte.js';
import type { ChatProcessingPresentationRegistry } from '$lib/ws/chat-processing-reconciler.svelte.js';

export interface ConversationLifecyclePort {
	forChat(chatId: string): ConversationLifecycleState;
	get(chatId: string): ConversationLifecycleState | null;
	beginTurn(chatId: string): void;
	clearTurnStatus(chatId: string): void;
	beginStopping(chatId: string, requestId: string): StoppingSnapshot | null;
	restoreStopping(
		chatId: string,
		requestId: string,
		snapshot: StoppingSnapshot | null,
	): void;
	applyProcessingPhase(chatId: string, phase: ChatProcessingPhase | null): void;
	applyProcessingSnapshotPhase(
		chatId: string,
		phase: ChatProcessingPhase | null,
		sentAt: number | null,
	): void;
	remove(chatId: string): void;
	prune(activeChatIds: ReadonlySet<string>): void;
}

export class ConversationLifecycleRegistry implements ConversationLifecyclePort {
	readonly #byChatId = $state.raw<Record<string, ConversationLifecycleState>>({});
	readonly #removeProcessingPresentation: () => void;

	constructor(options: {
		sessions: Pick<ChatSessionsPort, 'processingPhase'>;
		processing: ChatProcessingPresentationRegistry;
		conversationUi: Pick<ConversationUiPort, 'clearTurnPermissionRequestsForChat'>;
	}) {
		this.#removeProcessingPresentation = options.processing.addPresentation({
			currentChatId: null,
			matchesChat: () => true,
			applyProcessingPhase: (chatId, phase) => this.applyProcessingPhase(chatId, phase),
			applyProcessingSnapshotPhase: (chatId, phase, sentAt) =>
				this.applyProcessingSnapshotPhase(chatId, phase, sentAt),
			clearTurnPermissionRequests: (chatId) =>
				options.conversationUi.clearTurnPermissionRequestsForChat(chatId),
		});
		this.#processingPhase = (chatId) => options.sessions.processingPhase(chatId);
	}

	readonly #processingPhase: (chatId: string) => ChatProcessingPhase | null;

	forChat(chatId: string): ConversationLifecycleState {
		const existing = this.#byChatId[chatId];
		if (existing) return existing;
		const lifecycle = new ConversationLifecycleState();
		lifecycle.setCurrentChatId(chatId);
		lifecycle.applyProcessingPhase(chatId, this.#processingPhase(chatId));
		this.#byChatId[chatId] = lifecycle;
		return lifecycle;
	}

	get(chatId: string): ConversationLifecycleState | null {
		return this.#byChatId[chatId] ?? null;
	}

	beginTurn(chatId: string): void {
		this.forChat(chatId).beginTurn(chatId);
	}

	clearTurnStatus(chatId: string): void {
		this.get(chatId)?.clearTurnStatus(chatId);
	}

	beginStopping(chatId: string, requestId: string): StoppingSnapshot | null {
		return this.forChat(chatId).beginStopping(chatId, requestId);
	}

	restoreStopping(
		chatId: string,
		requestId: string,
		snapshot: StoppingSnapshot | null,
	): void {
		this.get(chatId)?.restoreStopping(chatId, requestId, snapshot);
	}

	applyProcessingPhase(chatId: string, phase: ChatProcessingPhase | null): void {
		if (phase === null) {
			this.get(chatId)?.applyProcessingPhase(chatId, null);
			return;
		}
		this.forChat(chatId).applyProcessingPhase(chatId, phase);
	}

	applyProcessingSnapshotPhase(
		chatId: string,
		phase: ChatProcessingPhase | null,
		sentAt: number | null,
	): void {
		if (phase === null) {
			this.get(chatId)?.applyProcessingSnapshotPhase(chatId, null, sentAt);
			return;
		}
		this.forChat(chatId).applyProcessingSnapshotPhase(chatId, phase, sentAt);
	}

	remove(chatId: string): void {
		if (!(chatId in this.#byChatId)) return;
		delete this.#byChatId[chatId];
	}

	prune(activeChatIds: ReadonlySet<string>): void {
		for (const chatId of Object.keys(this.#byChatId)) {
			if (!activeChatIds.has(chatId)) delete this.#byChatId[chatId];
		}
	}

	destroy(): void {
		this.#removeProcessingPresentation();
		for (const chatId of Object.keys(this.#byChatId)) delete this.#byChatId[chatId];
	}
}
