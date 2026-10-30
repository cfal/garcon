// Coordinates transcript and execution-control catch-up after a WebSocket reconnect.

import { untrack } from 'svelte';
import {
	ReconnectStateMessage,
	WsPongMessage,
	parseServerWsMessage,
	type ChatSubscribedMessage,
} from '$shared/ws-events';
import type { ChatExecutionControlState } from '$shared/chat-execution-control';
import type { ChatTranscriptCache } from '$lib/chat/transcript/chat-transcript-cache.svelte.js';
import type { ConversationUiPort } from '$lib/chat/conversation/conversation-ui-state.svelte.js';
import type { ChatSessionsPort } from '$lib/chat/sessions/chat-sessions-contract.js';
import { getChatExecutionControl } from '$lib/api/chats.js';
import type { WsMessageConsumer } from './connection.svelte.js';
import { requestTranscriptReplayPage } from './transcript-replay-request.js';
import type {
	TranscriptBufferedBatch,
	TranscriptReplayApplyResult,
} from '$lib/chat/transcript/transcript-reconnect-replay.js';

export interface ReconnectWsPort {
	isConnected: boolean;
	sendRequest(message: object): Promise<Record<string, unknown>>;
	addMessageConsumer(consumer: WsMessageConsumer): () => void;
}

export interface ReconnectPanelRegistryPort {
	readonly transcriptCache: Pick<ChatTranscriptCache, 'readAppliedCursor' | 'markValidated'>;
	visibleChatIds(): readonly string[];
	panelsForChat(chatId: string): readonly unknown[];
	markChatStale(chatId: string): void;
	markUndisplayedUnverified(): void;
	loadChatSnapshot(chatId: string): Promise<boolean>;
	beginReconnectReplay(chatId: string, transcriptViewId: string): number;
	applyReconnectReplayPage(
		token: number,
		chatId: string,
		batch: TranscriptBufferedBatch,
	): TranscriptReplayApplyResult | 'stale';
	finishReconnectReplay(token: number, chatId: string): TranscriptReplayApplyResult | 'stale';
	abortReconnectReplay(token: number, chatId: string): void;
	abortReconnectReplays(): void;
	noticeRevisionFor(chatId: string): number;
}

export type ReconnectConversationUiState = Pick<
	ConversationUiPort,
	| 'executionControlChatIds'
	| 'removeExecutionControl'
	| 'setExecutionControlFromRefresh'
	| 'markExecutionControlSocketDisconnected'
	| 'confirmExecutionControlSocketInstance'
	| 'setTransientFeedFromSnapshot'
>;

export interface ChatReconnectCoordinatorOptions {
	ws: ReconnectWsPort;
	panels: ReconnectPanelRegistryPort;
	conversationUi: ReconnectConversationUiState;
	sessions: Pick<ChatSessionsPort, 'selectedChatId' | 'quietRefreshChats'>;
	getExecutionControl?: (chatId: string) => Promise<{ control: ChatExecutionControlState }>;
}

const CONTROL_REFRESH_CONCURRENCY = 4;

interface TranscriptReplayInput {
	readonly chatId: string;
	readonly transcriptViewId: string;
	readonly afterOrdinal: number;
	readonly isCurrent: () => boolean;
	readonly apply: (message: ChatSubscribedMessage) => Promise<boolean | void> | boolean | void;
}

export class ChatReconnectCoordinator {
	#wasConnected = false;
	#hasConnectedBefore = false;
	#reconnectEpoch = 0;

	constructor(private readonly options: ChatReconnectCoordinatorOptions) {}

	mount(): void {
		$effect(() =>
			this.options.ws.addMessageConsumer((data) => {
				if (data.type !== 'ws-pong') return false;
				const message = parseServerWsMessage(data);
				if (!(message instanceof WsPongMessage)) return false;
				this.options.conversationUi.confirmExecutionControlSocketInstance(message.serverInstanceId);
				return false;
			}),
		);
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
			this.options.panels.abortReconnectReplays();
			this.options.conversationUi.markExecutionControlSocketDisconnected();
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

	// Only displayed chats replay transcript bodies. Undisplayed caches received
	// no bodies and lost their summaries while disconnected, so they catch up
	// from their cursors when shown.
	async #reconcileAfterReconnect(selectedChatId: string | null, epoch: number): Promise<void> {
		const visibleChatIds = [...this.options.panels.visibleChatIds()];
		this.options.panels.markUndisplayedUnverified();
		const globalReconciliation = this.#reconcileGlobalState(selectedChatId, epoch);
		const visibleResume = this.#resumeRenderedChats(visibleChatIds, epoch);
		const [, globalState] = await Promise.all([visibleResume, globalReconciliation]);
		if (epoch === this.#reconnectEpoch) await globalState.controlRefresh;
	}

	async #resumeRenderedChats(chatIds: readonly string[], epoch: number): Promise<void> {
		await Promise.all(chatIds.map((chatId) => this.#resumeRenderedChat(chatId, epoch)));
	}

	async #resumeRenderedChat(chatId: string, epoch: number): Promise<void> {
		const panels = this.options.panels;
		const cursor = panels.transcriptCache.readAppliedCursor(chatId);
		panels.markChatStale(chatId);
		if (!cursor?.transcriptViewId) {
			await this.#loadRenderedSnapshot(chatId, epoch);
			return;
		}
		const replayToken = panels.beginReconnectReplay(chatId, cursor.transcriptViewId);
		try {
			const message = await this.#replayTranscript({
				chatId,
				transcriptViewId: cursor.transcriptViewId,
				afterOrdinal: cursor.lastOrdinal,
				isCurrent: () => epoch === this.#reconnectEpoch && panels.panelsForChat(chatId).length > 0,
				apply: (page) =>
					panels.applyReconnectReplayPage(replayToken, chatId, {
						transcriptViewId: page.transcriptViewId,
						messages: page.messages,
						firstOrdinal: page.firstOrdinal,
						lastOrdinal: page.lastOrdinal,
						resendCandidates: page.resendCandidates,
						noticeRevision: panels.noticeRevisionFor(chatId),
					}) === 'applied',
			});
			if (!message) return;
			const replayResult = panels.finishReconnectReplay(replayToken, chatId);
			if (replayResult === 'stale') return;
			if (replayResult !== 'applied') {
				await this.#loadRenderedSnapshot(chatId, epoch);
				return;
			}
			const applied = panels.transcriptCache.readAppliedCursor(chatId);
			if (
				!applied ||
				applied.transcriptViewId !== cursor.transcriptViewId ||
				applied.lastOrdinal < message.throughOrdinal
			) {
				await this.#loadRenderedSnapshot(chatId, epoch);
				return;
			}
			panels.transcriptCache.markValidated(chatId);
		} catch {
			panels.abortReconnectReplay(replayToken, chatId);
			if (epoch === this.#reconnectEpoch) await this.#loadRenderedSnapshot(chatId, epoch);
		} finally {
			panels.abortReconnectReplay(replayToken, chatId);
		}
	}

	async #loadRenderedSnapshot(chatId: string, epoch: number): Promise<void> {
		const panels = this.options.panels;
		if (epoch !== this.#reconnectEpoch) return;
		let loaded: boolean;
		try {
			loaded = await panels.loadChatSnapshot(chatId);
		} catch {
			if (epoch === this.#reconnectEpoch) panels.markChatStale(chatId);
			return;
		}
		if (!loaded || epoch !== this.#reconnectEpoch || panels.panelsForChat(chatId).length === 0)
			return;
		panels.transcriptCache.markValidated(chatId);
	}

	async #reconcileGlobalState(
		selectedChatId: string | null,
		epoch: number,
	): Promise<{ controlRefresh: Promise<void> }> {
		const { controlRefresh } = await this.#requestReconnectState(
			this.#knownControlChatIds(selectedChatId),
			epoch,
		);
		if (epoch !== this.#reconnectEpoch) {
			return { controlRefresh: Promise.resolve() };
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

	async #replayTranscript(input: TranscriptReplayInput): Promise<ChatSubscribedMessage | null> {
		let afterOrdinal = input.afterOrdinal;
		let throughOrdinal: number | undefined;
		while (input.isCurrent()) {
			const message = await requestTranscriptReplayPage(this.options.ws, {
				chatId: input.chatId,
				transcriptViewId: input.transcriptViewId,
				afterOrdinal,
				...(throughOrdinal === undefined ? {} : { throughOrdinal }),
			});
			if (!input.isCurrent()) return null;
			throughOrdinal ??= message.throughOrdinal;

			const applied = await input.apply(message);
			if (applied === false) throw new Error('Transcript replay page could not be applied');
			if (!input.isCurrent()) return null;
			this.options.conversationUi.setTransientFeedFromSnapshot(message.transientFeed);
			if (!message.hasMore) return message;
			afterOrdinal = message.nextAfterOrdinal;
		}
		return null;
	}
}
