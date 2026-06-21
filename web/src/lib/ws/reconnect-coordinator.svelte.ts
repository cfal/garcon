// Coordinates selected-chat catch-up after a WebSocket reconnect. The server
// replies with same-generation deltas or asks the client to fetch a snapshot.

import { untrack } from 'svelte';
import {
	ChatSessionsRunningMessage,
	ChatSubscribedMessage,
	parseServerWsMessage,
} from '$shared/ws-events';
import type { QueueState } from '$shared/queue-state';
import type { ChatViewMessage } from '$shared/chat-view';
import type { ChatTranscriptCursor } from '$lib/chat/chat-transcript-cache.svelte';
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
	getBackgroundCursors: () => ChatTranscriptCursor[];
	getVisibleChatIds?: () => string[];
	getVisibleChatCursor?: (chatId: string) => ChatTranscriptCursor | null;
	loadVisibleChatSnapshot?: (chatId: string) => Promise<void> | void;
	onVisibleChatMessages?: (
		chatId: string,
		generationId: string,
		messages: ChatViewMessage[],
		lastSeq: number,
	) => Promise<boolean | void> | boolean | void;
	loadBackgroundSnapshot: (chatId: string) => Promise<void> | void;
	onBackgroundMessages?: (
		chatId: string,
		generationId: string,
		messages: ChatViewMessage[],
		lastSeq: number,
	) => Promise<boolean | void> | boolean | void;
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
			this.options.chatState.transcriptCache.markStale(selectedChatId);
			await this.#resumeSelectedChat(selectedChatId, epoch);
		}

		const visibleChatIds = this.#visibleChatIds(selectedChatId);
		await this.#resumeVisibleChats(visibleChatIds, epoch);

		const excludedBackgroundChatIds = new Set([
			...visibleChatIds,
			...(selectedChatId ? [selectedChatId] : []),
		]);
		await this.#resumeBackgroundChats(excludedBackgroundChatIds, runningChatIds, epoch);
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
			this.options.conversationUi.setMessageQueueFromRefresh(chatId, result.queue);
		} catch {
			// Later queue broadcasts will converge the visible queue state.
		}
	}

	async #resumeSelectedChat(chatId: string, epoch: number): Promise<void> {
		const cursor = this.options.chatState.getCursor();
		try {
			const message = await this.#subscribe(chatId, cursor.generationId, cursor.lastSeq);
			if (epoch !== this.#reconnectEpoch || this.options.getSelectedChatId() !== chatId) return;

			if (message.mode === 'snapshot-required') {
				await this.#loadSelectedSnapshot(chatId, epoch);
				return;
			}

			const result = this.options.chatState.applyMessages(
				chatId,
				message.generationId ?? '',
				message.messages,
			);
			if (result !== 'applied') {
				await this.#loadSelectedSnapshot(chatId, epoch);
				return;
			}
			if (message.lastSeq > this.options.chatState.getCursor().lastSeq) {
				await this.#loadSelectedSnapshot(chatId, epoch);
				return;
			}
			this.options.chatState.transcriptCache.markValidated(chatId);
		} catch {
			if (epoch !== this.#reconnectEpoch || this.options.getSelectedChatId() !== chatId) return;
			try {
				await this.#loadSelectedSnapshot(chatId, epoch);
			} catch {
				// Leaves the stale snapshot flag set so the next load revalidates.
			}
		}
	}

	async #loadSelectedSnapshot(chatId: string, epoch: number): Promise<void> {
		if (epoch !== this.#reconnectEpoch || this.options.getSelectedChatId() !== chatId) return;
		await this.options.chatState.loadMessages(chatId);
		if (epoch !== this.#reconnectEpoch || this.options.getSelectedChatId() !== chatId) return;
		this.options.chatState.transcriptCache.markValidated(chatId);
	}

	#visibleChatIds(selectedChatId: string | null): string[] {
		const ids = this.options.getVisibleChatIds?.() ?? [];
		return [...new Set(ids)].filter((chatId) => chatId && chatId !== selectedChatId);
	}

	async #resumeVisibleChats(chatIds: string[], epoch: number): Promise<void> {
		for (const chatId of chatIds) {
			if (epoch !== this.#reconnectEpoch) return;
			const cursor = this.options.getVisibleChatCursor?.(chatId) ?? null;
			if (!cursor) {
				await this.options.loadVisibleChatSnapshot?.(chatId);
				continue;
			}
			try {
				const message = await this.#subscribe(chatId, cursor.generationId, cursor.lastSeq);
				if (epoch !== this.#reconnectEpoch) return;
				if (message.mode === 'snapshot-required') {
					await this.options.loadVisibleChatSnapshot?.(chatId);
					continue;
				}
				if (message.messages.length === 0 && message.lastSeq > cursor.lastSeq) {
					await this.options.loadVisibleChatSnapshot?.(chatId);
					continue;
				}
				if (message.messages.length > 0) {
					const applied = await this.options.onVisibleChatMessages?.(
						chatId,
						message.generationId ?? '',
						message.messages,
						message.lastSeq,
					);
					if (applied === false) {
						await this.options.loadVisibleChatSnapshot?.(chatId);
					}
				}
			} catch {
				await this.options.loadVisibleChatSnapshot?.(chatId);
			}
		}
	}

	async #resumeBackgroundChats(
		excludedChatIds: Set<string>,
		runningChatIds: Set<string>,
		epoch: number,
	): Promise<void> {
		const cursors = this.options.getBackgroundCursors()
			.filter((cursor) => !excludedChatIds.has(cursor.chatId))
			.filter((cursor) => cursor.generationId && cursor.lastSeq > 0)
			.sort((left, right) => Number(runningChatIds.has(right.chatId)) - Number(runningChatIds.has(left.chatId)))
			.slice(0, BACKGROUND_RESUME_LIMIT);

		let shouldRefresh = false;
		for (const cursor of cursors) {
			if (epoch !== this.#reconnectEpoch) return;
			try {
				const message = await this.#subscribe(cursor.chatId, cursor.generationId, cursor.lastSeq);
				if (epoch !== this.#reconnectEpoch) return;
				if (message.mode === 'snapshot-required') {
					await this.options.loadBackgroundSnapshot(cursor.chatId);
					shouldRefresh = true;
					continue;
				}
				if (message.messages.length === 0 && message.lastSeq > cursor.lastSeq) {
					await this.options.loadBackgroundSnapshot(cursor.chatId);
					shouldRefresh = true;
					continue;
				}
				if (message.messages.length > 0) {
					const applied = await this.options.onBackgroundMessages?.(
						cursor.chatId,
						message.generationId ?? '',
						message.messages,
						message.lastSeq,
					);
					if (applied === false) {
						await this.options.loadBackgroundSnapshot(cursor.chatId);
					}
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
		generationId: string,
		afterSeq: number,
	): Promise<ChatSubscribedMessage> {
		const raw = await this.options.ws.sendRequest<Record<string, unknown>>({
			type: 'chat-subscribe',
			chatId,
			generationId,
			afterSeq,
		});
		const message = parseServerWsMessage(raw);
		if (!(message instanceof ChatSubscribedMessage) || message.chatId !== chatId) {
			throw new Error('Unexpected chat-subscribe response');
		}
		return message;
	}
}
