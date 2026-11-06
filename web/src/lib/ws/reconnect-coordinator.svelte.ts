// Coordinates transcript and execution-control catch-up after a WebSocket reconnect.

import { untrack } from 'svelte';
import {
	ReconnectStateMessage,
	WsPongMessage,
	parseServerWsMessage,
} from '$shared/ws-events';
import type { ChatExecutionControlState } from '$shared/chat-execution-control';
import type { ConversationUiPort } from '$lib/chat/conversation/conversation-ui-state.svelte.js';
import type { ChatSessionsPort } from '$lib/chat/sessions/chat-sessions-contract.js';
import { getChatExecutionControl } from '$lib/api/chats.js';
import type { WsMessageConsumer } from './connection.svelte.js';
export interface ReconnectWsPort {
	isConnected: boolean;
	sendRequest(message: object): Promise<Record<string, unknown>>;
	addMessageConsumer(consumer: WsMessageConsumer): () => void;
}

export interface ReconnectPanelRegistryPort {
	visibleChatIds(): readonly string[];
	cancelRefreshes(): void;
	resetServerInstance(serverInstanceId: string): void;
	loadChatSnapshot(chatId: string): Promise<boolean>;
}

export type ReconnectConversationUiState = Pick<
	ConversationUiPort,
	| 'executionControlChatIds'
	| 'removeExecutionControl'
	| 'setExecutionControlFromRefresh'
	| 'markExecutionControlSocketDisconnected'
	| 'confirmExecutionControlSocketInstance'
>;

export interface ChatReconnectCoordinatorOptions {
	ws: ReconnectWsPort;
	panels: ReconnectPanelRegistryPort;
	conversationUi: ReconnectConversationUiState;
	sessions: Pick<ChatSessionsPort, 'selectedChatId' | 'quietRefreshChats'>;
	getExecutionControl?: (chatId: string) => Promise<{ control: ChatExecutionControlState }>;
}

const CONTROL_REFRESH_CONCURRENCY = 4;

export class ChatReconnectCoordinator {
	#wasConnected = false;
	#reconnectEpoch = 0;

	constructor(private readonly options: ChatReconnectCoordinatorOptions) {}

	mount(): void {
		$effect(() => {
			const unsubscribe = this.options.ws.addMessageConsumer((data) => {
				if (data.type !== 'ws-pong') return false;
				const message = parseServerWsMessage(data);
				if (!(message instanceof WsPongMessage)) return false;
				this.options.conversationUi.confirmExecutionControlSocketInstance(message.serverInstanceId);
			this.options.panels.resetServerInstance(message.serverInstanceId);
				return false;
			});
			return () => { unsubscribe(); this.dispose(); };
		});
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
			this.options.panels.cancelRefreshes();
			this.options.conversationUi.markExecutionControlSocketDisconnected();
			return;
		}
		if (this.#wasConnected) return;
		this.#wasConnected = true;
		await this.#handleConnected();
	}

	async #handleConnected(): Promise<void> {
		const chatId = this.options.sessions.selectedChatId;

		const epoch = ++this.#reconnectEpoch;
		await this.#reconcileAfterReconnect(chatId, epoch);
	}

	async #reconcileAfterReconnect(selectedChatId: string | null, epoch: number): Promise<void> {
		const { controlRefresh } = await this.#requestReconnectState(this.#knownControlChatIds(selectedChatId), epoch);
		if (epoch !== this.#reconnectEpoch) return;
		const listRefresh = this.#refreshChatsQuietly();
		const refreshes = this.options.panels.visibleChatIds().map(async chatId => {
			if (epoch !== this.#reconnectEpoch) return;
			try { await this.options.panels.loadChatSnapshot(chatId); } catch { /* A surface retains its explicit retry state. */ }
		});
		await Promise.all([...refreshes, controlRefresh, listRefresh]);
	}

	async #requestReconnectState(
		controlChatIds: string[],
		epoch: number,
	): Promise<{ controlRefresh: Promise<void> }> {
		try {
			const raw = await this.options.ws.sendRequest({
				type: 'reconnect-state-query',
				controlChatIds,
			});
			const message = parseServerWsMessage(raw);
			if (!(message instanceof ReconnectStateMessage) || epoch !== this.#reconnectEpoch) {
				throw new Error('Unexpected reconnect-state response');
			}
			this.options.conversationUi.confirmExecutionControlSocketInstance(message.serverInstanceId);
			this.options.panels.resetServerInstance(message.serverInstanceId);

			const requestedChatIds = new Set(controlChatIds);
			const returnedChatIds = new Set<string>();
			const unavailableChatIds: string[] = [];
			for (const result of message.controlResults) {
				if (!requestedChatIds.has(result.chatId)) continue;
				returnedChatIds.add(result.chatId);
				if (result.outcome === 'snapshot') {
					this.options.conversationUi.setExecutionControlFromRefresh(result.chatId, result.control);
				} else if (result.outcome === 'not-found') {
					this.options.conversationUi.removeExecutionControl(result.chatId);
				} else {
					unavailableChatIds.push(result.chatId);
				}
			}
			for (const chatId of controlChatIds) {
				if (!returnedChatIds.has(chatId)) unavailableChatIds.push(chatId);
			}

			return {
				controlRefresh: this.#refreshControls(unavailableChatIds, epoch),
			};
		} catch {
			if (epoch !== this.#reconnectEpoch) return { controlRefresh: Promise.resolve() };
			return {
				controlRefresh: this.#refreshControls(controlChatIds, epoch),
			};
		}
	}

	async #refreshControl(chatId: string, expectedEpoch?: number): Promise<void> {
		try {
			const result = await (this.options.getExecutionControl ?? getChatExecutionControl)(chatId);
			if (expectedEpoch !== undefined && expectedEpoch !== this.#reconnectEpoch) return;
			this.options.conversationUi.setExecutionControlFromRefresh(chatId, result.control);
		} catch {
			// Later queue broadcasts will converge the visible queue state.
		}
	}

	#knownControlChatIds(selectedChatId: string | null): string[] {
		return [
			...(selectedChatId ? [selectedChatId] : []),
			...this.options.conversationUi.executionControlChatIds,
		].filter((chatId, index, all) => chatId && all.indexOf(chatId) === index);
	}

	async #refreshControls(chatIds: string[], epoch: number): Promise<void> {
		for (let index = 0; index < chatIds.length; index += CONTROL_REFRESH_CONCURRENCY) {
			if (epoch !== this.#reconnectEpoch) return;
			await Promise.all(
				chatIds
					.slice(index, index + CONTROL_REFRESH_CONCURRENCY)
					.map((chatId) => this.#refreshControl(chatId, epoch)),
			);
		}
	}

	async #refreshChatsQuietly(): Promise<void> {
		try {
			await this.options.sessions.quietRefreshChats();
		} catch (error) {
			console.warn('[ChatReconnectCoordinator] Chat-list refresh failed', error);
		}
	}
	dispose(): void { this.#reconnectEpoch++; this.#wasConnected = false; this.options.panels.cancelRefreshes(); }
}
