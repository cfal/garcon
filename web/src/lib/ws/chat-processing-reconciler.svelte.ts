import {
	ChatProcessingUpdatedMessage,
	ReconnectStateMessage,
	WsPongMessage,
	parseServerWsMessage,
	type ReconnectProcessingResult,
} from '$shared/ws-events';
import type { ChatSessionsPort } from '$lib/chat/sessions/chat-sessions.svelte.js';
import type { ConversationLifecycleState } from '$lib/chat/conversation/conversation-lifecycle-state.svelte.js';
import type { ConversationUiPort } from '$lib/chat/conversation/conversation-ui-state.svelte.js';
import type { WsConnection } from './connection.svelte.js';

export interface ChatProcessingPresentation {
	readonly currentChatId: string | null;
	applyProcessingPhase: ConversationLifecycleState['applyProcessingPhase'];
	applyProcessingSnapshotPhase: ConversationLifecycleState['applyProcessingSnapshotPhase'];
	clearTurnPermissionRequests: ConversationUiPort['clearTurnPermissionRequests'];
}

export interface ChatProcessingPresentationRegistry {
	addPresentation(presentation: ChatProcessingPresentation): () => void;
}

export class ChatProcessingReconciler implements ChatProcessingPresentationRegistry {
	readonly #removeConsumer: () => void;
	readonly #presentations = new Set<ChatProcessingPresentation>();

	constructor(
		connection: Pick<WsConnection, 'addMessageConsumer'>,
		private readonly sessions: Pick<
			ChatSessionsPort,
			'applyProcessingEvent' | 'processingPhase' | 'reconcileProcessing'
		>,
	) {
		this.#removeConsumer = connection.addMessageConsumer((data) => this.#consume(data));
	}

	addPresentation(presentation: ChatProcessingPresentation): () => void {
		this.#presentations.add(presentation);
		return () => this.#presentations.delete(presentation);
	}

	destroy(): void {
		this.#presentations.clear();
		this.#removeConsumer();
	}

	#consume(data: Record<string, unknown>): boolean {
		if (
			data.type !== 'chat-processing-updated'
			&& data.type !== 'reconnect-state'
			&& data.type !== 'ws-pong'
		) return false;

		const message = parseServerWsMessage(data);
		if (message instanceof ChatProcessingUpdatedMessage) {
			this.sessions.applyProcessingEvent(message.chatId, message.phase);
			this.#applyPresentationPhase(message.chatId, message.phase);
			return true;
		}
		if (message instanceof ReconnectStateMessage || message instanceof WsPongMessage) {
			this.#applySnapshot(
				message.processing,
				message instanceof WsPongMessage ? message.sentAt : null,
			);
		}
		return false;
	}

	#applySnapshot(result: ReconnectProcessingResult, sentAt: number | null): void {
		if (result.outcome !== 'snapshot') {
			console.warn('[ChatProcessingReconciler] Processing snapshot unavailable');
			return;
		}
		const transitions = this.sessions.reconcileProcessing(result.chats);
		if (transitions.length > 0) {
			console.info('[ChatProcessingReconciler] Processing snapshot repaired state', {
				transitionCount: transitions.length,
				runningCount: transitions.filter((entry) => entry.phase === 'running').length,
				stoppingCount: transitions.filter((entry) => entry.phase === 'stopping').length,
				idleCount: transitions.filter((entry) => entry.phase === null).length,
			});
		}
		const changedChatIds = new Set<string>();
		for (const transition of transitions) {
			changedChatIds.add(transition.chatId);
			this.#applyPresentationSnapshotPhase(transition.chatId, transition.phase, sentAt);
		}
		for (const presentation of this.#presentations) {
			const chatId = presentation.currentChatId;
			if (!chatId || changedChatIds.has(chatId)) continue;
			this.#applyPresentationSnapshot(
				presentation,
				chatId,
				this.sessions.processingPhase(chatId),
				sentAt,
			);
		}
	}

	#applyPresentationPhase(
		chatId: string,
		phase: Parameters<ConversationLifecycleState['applyProcessingPhase']>[1],
	): void {
		for (const presentation of this.#presentations) {
			this.#applyPresentation(presentation, chatId, phase);
		}
	}

	#applyPresentationSnapshotPhase(
		chatId: string,
		phase: Parameters<ConversationLifecycleState['applyProcessingPhase']>[1],
		sentAt: number | null,
	): void {
		for (const presentation of this.#presentations) {
			this.#applyPresentationSnapshot(presentation, chatId, phase, sentAt);
		}
	}

	#applyPresentation(
		presentation: ChatProcessingPresentation,
		chatId: string,
		phase: Parameters<ConversationLifecycleState['applyProcessingPhase']>[1],
	): void {
		if (presentation.currentChatId !== chatId) return;
		presentation.applyProcessingPhase(chatId, phase);
		if (phase === null) presentation.clearTurnPermissionRequests();
	}

	#applyPresentationSnapshot(
		presentation: ChatProcessingPresentation,
		chatId: string,
		phase: Parameters<ConversationLifecycleState['applyProcessingPhase']>[1],
		sentAt: number | null,
	): void {
		if (presentation.currentChatId !== chatId) return;
		presentation.applyProcessingSnapshotPhase(chatId, phase, sentAt);
		if (phase === null) presentation.clearTurnPermissionRequests();
	}
}
