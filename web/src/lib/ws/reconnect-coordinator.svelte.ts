// Coordinates selected-chat catch-up after a WebSocket reconnect. The
// server replies with event-log deltas when the local cursor is still valid,
// or asks the client to fetch a fresh snapshot when the generation changed.

import { untrack } from 'svelte';
import {
	ChatSessionsRunningMessage,
	ChatSubscribedMessage,
	parseServerWsMessage,
} from '$shared/ws-events';
import type { QueueState } from '$shared/queue-state';
import type { ChatMessageEvent } from '$shared/chat-events';
import type { CachedChatCursor } from '$lib/chat/chat-snapshot-cache';
import type { ChatState } from '$lib/chat/state.svelte';
import type { ConversationUiStore } from '$lib/stores/conversation-ui.svelte';
import { extractRunningChatIds } from '$lib/events/handlers/chat-sessions-running';
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
	reconcileProcessing: (activeChatIds: Set<string>) => void;
	quietRefreshChats: () => Promise<void> | void;
	getBackgroundCursors: () => CachedChatCursor[];
	loadBackgroundSnapshot: (chatId: string) => Promise<void> | void;
	onBackgroundEvents?: (
		chatId: string,
		logId: string,
		events: ChatMessageEvent[],
		lastAppendSeq: number,
	) => Promise<void> | void;
}

const BACKGROUND_RESUME_LIMIT = 20;

export class ChatReconnectCoordinator {
	#wasConnected = false;
	#hasConnectedBefore = false;
	#reconnectEpoch = 0;

	constructor(private readonly options: ChatReconnectCoordinatorOptions) {}

	mount(): void {
		$effect(() => {
			const connected = this.options.ws.isConnected;
			untrack(() => {
				void this.handleConnectionState(connected);
			});
		});
	}

	async handleConnectionState(connected: boolean): Promise<void> {
		if (!connected) {
			this.#wasConnected = false;
			this.#reconnectEpoch += 1;
			return;
		}
		if (this.#wasConnected) return;
		this.#wasConnected = true;
		await this.#handleConnected();
	}

	async #handleConnected(): Promise<void> {
		const selected = this.options.getSelectedChat();
		const chatId = this.options.getSelectedChatId();

		if (selected?.status === 'running') {
			void this.#refreshQueue(selected.id);
		}

		if (!this.#hasConnectedBefore) {
			this.#hasConnectedBefore = true;
			return;
		}

		const epoch = ++this.#reconnectEpoch;
		await this.#reconcileAfterReconnect(chatId, epoch);
	}

	async #reconcileAfterReconnect(selectedChatId: string | null, epoch: number): Promise<void> {
		const runningChatIds = await this.#requestRunningChatIds();
		if (epoch !== this.#reconnectEpoch) return;

		this.options.reconcileProcessing(runningChatIds);
		await this.options.quietRefreshChats();
		if (epoch !== this.#reconnectEpoch) return;

		if (selectedChatId && runningChatIds.has(selectedChatId)) {
			await this.#refreshQueue(selectedChatId);
		}

		if (selectedChatId) {
			this.options.chatState.snapshotCache.markStale(selectedChatId);
			await this.#resumeSelectedChat(selectedChatId, epoch);
		}

		await this.#resumeBackgroundChats(selectedChatId, runningChatIds, epoch);
	}

	async #requestRunningChatIds(): Promise<Set<string>> {
		try {
			const raw = await this.options.ws.sendRequest<Record<string, unknown>>({
				type: 'chats-running-query',
			});
			const message = parseServerWsMessage(raw);
			if (!(message instanceof ChatSessionsRunningMessage)) return new Set();
			return extractRunningChatIds(message);
		} catch {
			return new Set();
		}
	}

	async #refreshQueue(chatId: string): Promise<void> {
		try {
			const result = await this.options.getQueue(chatId);
			this.options.conversationUi.setMessageQueue(chatId, result.queue);
		} catch {
			// Later queue broadcasts will converge the visible queue state.
		}
	}

	async #resumeSelectedChat(chatId: string, epoch: number): Promise<void> {
		const cursor = this.options.chatState.getCursor();
		try {
			const message = await this.#subscribe(chatId, cursor.logId, cursor.lastAppendSeq);
			if (epoch !== this.#reconnectEpoch || this.options.getSelectedChatId() !== chatId) return;

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

	async #resumeBackgroundChats(
		selectedChatId: string | null,
		runningChatIds: Set<string>,
		epoch: number,
	): Promise<void> {
		const cursors = this.options.getBackgroundCursors()
			.filter((cursor) => cursor.chatId !== selectedChatId)
			.filter((cursor) => cursor.logId && cursor.lastAppendSeq > 0)
			.sort((left, right) => Number(runningChatIds.has(right.chatId)) - Number(runningChatIds.has(left.chatId)))
			.slice(0, BACKGROUND_RESUME_LIMIT);

		let shouldRefresh = false;
		for (const cursor of cursors) {
			if (epoch !== this.#reconnectEpoch) return;
			try {
				const message = await this.#subscribe(cursor.chatId, cursor.logId, cursor.lastAppendSeq);
				if (epoch !== this.#reconnectEpoch) return;
				if (message.mode === 'snapshot-required') {
					await this.options.loadBackgroundSnapshot(cursor.chatId);
					shouldRefresh = true;
					continue;
				}
				if (message.events.length > 0) {
					await this.options.onBackgroundEvents?.(
						cursor.chatId,
						message.logId,
						message.events,
						message.lastAppendSeq,
					);
					shouldRefresh = true;
				}
			} catch {
				// Background resume is opportunistic; visible selected-chat recovery wins.
			}
		}

		if (epoch === this.#reconnectEpoch && shouldRefresh) {
			await this.options.quietRefreshChats();
		}
	}

	async #subscribe(
		chatId: string,
		logId: string,
		afterAppendSeq: number,
	): Promise<ChatSubscribedMessage> {
		const raw = await this.options.ws.sendRequest<Record<string, unknown>>({
			type: 'chat-subscribe',
			chatId,
			logId,
			afterAppendSeq,
		});
		const message = parseServerWsMessage(raw);
		if (!(message instanceof ChatSubscribedMessage) || message.chatId !== chatId) {
			throw new Error('Unexpected chat-subscribe response');
		}
		return message;
	}
}
