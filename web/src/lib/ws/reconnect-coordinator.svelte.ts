// Coordinates selected-chat catch-up after a WebSocket reconnect. The
// server replies with event-log deltas when the local cursor is still valid,
// or asks the client to fetch a fresh snapshot when the generation changed.

import { untrack } from 'svelte';
import { ChatSubscribedMessage, parseServerWsMessage } from '$shared/ws-events';
import type { QueueState } from '$shared/queue-state';
import type { ChatState } from '$lib/chat/state.svelte';
import type { ConversationUiStore } from '$lib/stores/conversation-ui.svelte';
import type { WsConnection } from './connection.svelte';

interface ReconnectChatSession {
	id: string;
	status?: string;
}

export interface ChatReconnectCoordinatorOptions {
	ws: WsConnection;
	chatState: ChatState;
	conversationUi: ConversationUiStore;
	getSelectedChat: () => ReconnectChatSession | null;
	getSelectedChatId: () => string | null;
	getQueue: (chatId: string) => Promise<{ queue: QueueState }>;
}

export class ChatReconnectCoordinator {
	#wasConnected = false;
	#hasConnectedBefore = false;
	#reconnectEpoch = 0;

	constructor(private readonly options: ChatReconnectCoordinatorOptions) {}

	mount(): void {
		$effect(() => {
			const connected = this.options.ws.isConnected;
			untrack(() => {
				if (!connected) {
					this.#wasConnected = false;
					return;
				}
				if (this.#wasConnected) return;
				this.#wasConnected = true;
				this.#handleConnected();
			});
		});
	}

	#handleConnected(): void {
		const selected = this.options.getSelectedChat();
		const chatId = this.options.getSelectedChatId();

		if (selected?.status === 'running') {
			void this.options.getQueue(selected.id)
				.then((result) => {
					this.options.conversationUi.setMessageQueue(selected.id, result.queue);
				})
				.catch(() => {
					// Later queue broadcasts will converge the visible queue state.
				});
		}

		if (!this.#hasConnectedBefore) {
			this.#hasConnectedBefore = true;
			return;
		}
		if (!chatId) return;

		this.options.chatState.snapshotCache.markStale(chatId);
		void this.#resumeChat(chatId, ++this.#reconnectEpoch);
	}

	async #resumeChat(chatId: string, epoch: number): Promise<void> {
		const cursor = this.options.chatState.getCursor();
		try {
			const raw = await this.options.ws.sendRequest<Record<string, unknown>>({
				type: 'chat-subscribe',
				chatId,
				logId: cursor.logId,
				afterAppendSeq: cursor.lastAppendSeq,
			});
			if (epoch !== this.#reconnectEpoch || this.options.getSelectedChatId() !== chatId) return;
			const message = parseServerWsMessage(raw);
			if (!(message instanceof ChatSubscribedMessage) || message.chatId !== chatId) return;

			if (message.mode === 'snapshot-required') {
				await this.options.chatState.loadMessages(chatId);
				this.options.chatState.snapshotCache.markValidated(chatId);
				return;
			}

			const result = this.options.chatState.applyEvents(message.logId, message.events);
			if (result === 'generation-changed') {
				await this.options.chatState.loadMessages(chatId);
			}
			this.options.chatState.snapshotCache.markValidated(chatId);
		} catch {
			// The stale snapshot flag remains set so the next load revalidates.
		}
	}
}
