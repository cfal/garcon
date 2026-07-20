// Coordinates selected-chat catch-up after a WebSocket reconnect. The server
// replies with same-generation deltas or asks the client to fetch a snapshot.

import { untrack } from 'svelte';
import {
	ChatSubscribedMessage,
	ReconnectStateMessage,
	parseServerWsMessage,
} from '$shared/ws-events';
import type { ChatExecutionControlState } from '$shared/chat-execution-control';
import type { ChatViewMessage } from '$shared/chat-view';
import type { ChatTranscriptCursor } from '$lib/chat/transcript/chat-transcript-cache.svelte.js';
import type { ActiveTranscriptPort } from '$lib/chat/transcript/active-transcript-state.svelte.js';
import type { ConversationUiPort } from '$lib/chat/conversation/conversation-ui-state.svelte.js';
import type { ChatSessionsPort } from '$lib/chat/sessions/chat-sessions.svelte.js';
import { getChatExecutionControl } from '$lib/api/chats.js';

export interface ReconnectWsPort {
	isConnected: boolean;
	sendRequest(message: object): Promise<Record<string, unknown>>;
}

export type ReconnectTranscriptState = Pick<
	ActiveTranscriptPort,
	'getCursor' | 'applyMessages' | 'setPendingUserInputs' | 'loadMessages'
> & {
	transcriptCache: {
		markStale(chatId: string): void;
		markValidated(chatId: string): void;
	};
};

export type ReconnectConversationUiState = Pick<
	ConversationUiPort,
	'executionControlChatIds' | 'removeExecutionControl' | 'setExecutionControlFromRefresh'
>;

export interface ChatReconnectCoordinatorOptions {
	ws: ReconnectWsPort;
	chatState: ReconnectTranscriptState;
	conversationUi: ReconnectConversationUiState;
	sessions: Pick<
		ChatSessionsPort,
		| 'selectedChatId'
		| 'reconcileProcessing'
		| 'invalidateProcessingAuthority'
		| 'quietRefreshChats'
	>;
	getExecutionControl?: (chatId: string) => Promise<{ control: ChatExecutionControlState }>;
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
const CONTROL_REFRESH_CONCURRENCY = 4;

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
			this.options.sessions.invalidateProcessingAuthority();
			return;
		}
		if (this.#wasConnected) return;
		this.#wasConnected = true;
		await this.#handleConnected();
	}

	async #handleConnected(): Promise<void> {
		const chatId = this.options.sessions.selectedChatId;

		if (!this.#hasConnectedBefore) {
			this.#hasConnectedBefore = true;
			const epoch = ++this.#reconnectEpoch;
			const globalState = await this.#reconcileGlobalState(chatId, epoch);
			if (epoch === this.#reconnectEpoch) await globalState.controlRefresh;
			return;
		}

		const epoch = ++this.#reconnectEpoch;
		await this.#reconcileAfterReconnect(chatId, epoch);
	}

	async #reconcileAfterReconnect(selectedChatId: string | null, epoch: number): Promise<void> {
		let selectedResume: Promise<void> = Promise.resolve();
		if (selectedChatId) {
			this.options.chatState.transcriptCache.markStale(selectedChatId);
			selectedResume = this.#resumeSelectedChat(selectedChatId, epoch);
		}

		const visibleChatIds = this.#visibleChatIds(selectedChatId);
		const excludedBackgroundChatIds = new Set([
			...visibleChatIds,
			...(selectedChatId ? [selectedChatId] : []),
		]);
		const globalReconciliation = this.#reconcileGlobalState(selectedChatId, epoch);
		const visibleResume = this.#resumeVisibleChats(visibleChatIds, epoch);
		const backgroundResume = this.#resumeBackgroundChats(excludedBackgroundChatIds, epoch);
		const [, globalState] = await Promise.all([
			Promise.all([selectedResume, visibleResume, backgroundResume]),
			globalReconciliation,
		]);
		if (epoch !== this.#reconnectEpoch) return;
		await globalState.controlRefresh;
	}

	async #reconcileGlobalState(
		selectedChatId: string | null,
		epoch: number,
	): Promise<{ controlRefresh: Promise<void> }> {
		const { runningChatIds, controlRefresh } = await this.#requestReconnectState(
			this.#knownControlChatIds(selectedChatId),
			epoch,
		);
		if (epoch !== this.#reconnectEpoch) {
			return { controlRefresh: Promise.resolve() };
		}

		if (runningChatIds !== null) {
			this.options.sessions.reconcileProcessing(runningChatIds);
		} else {
			this.options.sessions.invalidateProcessingAuthority();
		}
		await this.#refreshChatsQuietly();
		if (epoch !== this.#reconnectEpoch) {
			return { controlRefresh: Promise.resolve() };
		}

		return { controlRefresh };
	}

	async #requestReconnectState(
		controlChatIds: string[],
		epoch: number,
	): Promise<{ runningChatIds: Set<string> | null; controlRefresh: Promise<void> }> {
		try {
			const raw = await this.options.ws.sendRequest({
				type: 'reconnect-state-query',
				controlChatIds,
			});
			const message = parseServerWsMessage(raw);
			if (!(message instanceof ReconnectStateMessage) || epoch !== this.#reconnectEpoch) {
				throw new Error('Unexpected reconnect-state response');
			}

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
				runningChatIds:
					message.processing.outcome === 'snapshot'
						? new Set(message.processing.runningChatIds)
						: null,
				controlRefresh: this.#refreshControls(unavailableChatIds, epoch),
			};
		} catch {
			return {
				runningChatIds: null,
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

	async #resumeSelectedChat(chatId: string, epoch: number): Promise<void> {
		const cursor = this.options.chatState.getCursor();
		try {
			const message = await this.#subscribe(chatId, cursor.generationId, cursor.lastSeq);
			if (epoch !== this.#reconnectEpoch || this.options.sessions.selectedChatId !== chatId) return;

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
			this.options.chatState.setPendingUserInputs(message.pendingUserInputs);
			this.options.chatState.transcriptCache.markValidated(chatId);
		} catch {
			if (epoch !== this.#reconnectEpoch || this.options.sessions.selectedChatId !== chatId) return;
			try {
				await this.#loadSelectedSnapshot(chatId, epoch);
			} catch {
				// Leaves the stale snapshot flag set so the next load revalidates.
			}
		}
	}

	async #loadSelectedSnapshot(chatId: string, epoch: number): Promise<void> {
		if (epoch !== this.#reconnectEpoch || this.options.sessions.selectedChatId !== chatId) return;
		await this.options.chatState.loadMessages(chatId);
		if (epoch !== this.#reconnectEpoch || this.options.sessions.selectedChatId !== chatId) return;
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
				await this.#loadVisibleSnapshot(chatId, epoch);
				continue;
			}
			try {
				const message = await this.#subscribe(chatId, cursor.generationId, cursor.lastSeq);
				if (epoch !== this.#reconnectEpoch) return;
				if (message.mode === 'snapshot-required') {
					await this.#loadVisibleSnapshot(chatId, epoch);
					continue;
				}
				if (message.messages.length === 0 && message.lastSeq > cursor.lastSeq) {
					await this.#loadVisibleSnapshot(chatId, epoch);
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
						await this.#loadVisibleSnapshot(chatId, epoch);
					}
				}
			} catch {
				await this.#loadVisibleSnapshot(chatId, epoch);
			}
		}
	}

	async #loadVisibleSnapshot(chatId: string, epoch: number): Promise<void> {
		if (epoch !== this.#reconnectEpoch) return;
		await this.options.loadVisibleChatSnapshot?.(chatId);
	}

	async #resumeBackgroundChats(excludedChatIds: Set<string>, epoch: number): Promise<void> {
		const cursors = this.options
			.getBackgroundCursors()
			.filter((cursor) => !excludedChatIds.has(cursor.chatId))
			.filter((cursor) => cursor.generationId && cursor.lastSeq > 0)
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
			await this.#refreshChatsQuietly();
		}
	}

	async #refreshChatsQuietly(): Promise<void> {
		try {
			await this.options.sessions.quietRefreshChats();
		} catch (error) {
			console.warn('[ChatReconnectCoordinator] Chat-list refresh failed', error);
		}
	}

	async #subscribe(
		chatId: string,
		generationId: string,
		afterSeq: number,
	): Promise<ChatSubscribedMessage> {
		const raw = await this.options.ws.sendRequest({
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
