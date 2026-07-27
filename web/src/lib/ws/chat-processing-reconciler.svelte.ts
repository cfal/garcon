import {
	ChatProcessingUpdatedMessage,
	ReconnectStateMessage,
	WsPongMessage,
	parseServerWsMessage,
	type ReconnectProcessingResult,
} from '$shared/ws-events';
import type { ChatSessionsPort } from '$lib/chat/sessions/chat-sessions.svelte.js';
import type { ConversationLifecycleState } from '$lib/chat/conversation/conversation-lifecycle-state.svelte.js';
import type { WsConnection } from './connection.svelte.js';

export class ChatProcessingReconciler {
	readonly #removeConsumer: () => void;

	constructor(
		connection: Pick<WsConnection, 'addMessageConsumer'>,
		private readonly sessions: Pick<
			ChatSessionsPort,
			'applyProcessingEvent' | 'reconcileProcessing'
		>,
		private readonly lifecycle: Pick<ConversationLifecycleState, 'applyProcessingPhase'>,
	) {
		this.#removeConsumer = connection.addMessageConsumer((data) => this.#consume(data));
	}

	destroy(): void {
		this.#removeConsumer();
	}

	#consume(data: Record<string, unknown>): boolean {
		const message = parseServerWsMessage(data);
		if (message instanceof ChatProcessingUpdatedMessage) {
			this.sessions.applyProcessingEvent(message.chatId, message.phase);
			this.lifecycle.applyProcessingPhase(message.chatId, message.phase);
			return true;
		}
		if (message instanceof ReconnectStateMessage || message instanceof WsPongMessage) {
			this.#applySnapshot(message.processing);
		}
		return false;
	}

	#applySnapshot(result: ReconnectProcessingResult): void {
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
		for (const transition of transitions) {
			this.lifecycle.applyProcessingPhase(transition.chatId, transition.phase);
		}
	}
}
