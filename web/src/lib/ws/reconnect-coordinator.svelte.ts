// Coordinates selected-chat catch-up after a WebSocket reconnect. The server
// replies with same-generation deltas or asks the client to fetch a snapshot.

import { untrack } from 'svelte';
import {
	ChatSubscribedMessage,
	ReconnectStateMessage,
	WsPongMessage,
	parseServerWsMessage,
} from '$shared/ws-events';
import type { ChatExecutionControlState } from '$shared/chat-execution-control';
import type { TranscriptMessage } from '$shared/chat-view';
import type { ChatTranscriptCursor } from '$lib/chat/transcript/chat-transcript-cache.svelte.js';
import type { ActiveTranscriptPort } from '$lib/chat/transcript/active-transcript-state.svelte.js';
import type { ConversationUiPort } from '$lib/chat/conversation/conversation-ui-state.svelte.js';
import type { ChatSessionsPort } from '$lib/chat/sessions/chat-sessions.svelte.js';
import { getChatExecutionControl } from '$lib/api/chats.js';
import type { WsMessageConsumer } from './connection.svelte.js';
import type { ConversationPanelRegistry } from '$lib/chat/conversation/conversation-panel-registry.svelte.js';

export interface ReconnectWsPort {
	isConnected: boolean;
	sendRequest(message: object): Promise<Record<string, unknown>>;
	addMessageConsumer(consumer: WsMessageConsumer): () => void;
}

export type ReconnectTranscriptState = Pick<
	ActiveTranscriptPort,
	| 'getCursor'
	| 'applyMessages'
	| 'beginReconnectReplay'
	| 'applyReconnectReplayPage'
	| 'finishReconnectReplay'
	| 'abortReconnectReplay'
	| 'loadMessages'
> & {
	transcriptCache: {
		markStale(chatId: string): void;
		markValidated(chatId: string): void;
	};
};

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
	chatState: ReconnectTranscriptState;
	panels?: ConversationPanelRegistry;
	conversationUi: ReconnectConversationUiState;
	sessions: Pick<
		ChatSessionsPort,
		| 'selectedChatId'
		| 'quietRefreshChats'
	>;
	getExecutionControl?: (chatId: string) => Promise<{ control: ChatExecutionControlState }>;
	getBackgroundCursors: () => ChatTranscriptCursor[];
	markBackgroundStale: (chatId: string) => void;
	onBackgroundMessages?: (
		chatId: string,
		transcriptViewId: string,
		messages: TranscriptMessage[],
		firstOrdinal: number,
		lastOrdinal: number,
	) => Promise<boolean | void> | boolean | void;
}

const BACKGROUND_RESUME_LIMIT = 20;
const CONTROL_REFRESH_CONCURRENCY = 4;

interface TranscriptReplayInput {
	readonly chatId: string;
	readonly transcriptViewId: string;
	readonly afterOrdinal: number;
	readonly isCurrent: () => boolean;
	readonly apply: (message: ChatSubscribedMessage) => Promise<boolean | void> | boolean | void;
}

interface SelectedTranscriptReplay {
	readonly token: number;
}

export class ChatReconnectCoordinator {
	#wasConnected = false;
	#hasConnectedBefore = false;
	#reconnectEpoch = 0;
	#selectedTranscriptReplay: SelectedTranscriptReplay | null = null;
	#renderedTranscriptReplays = new Map<string, number>();

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
			this.#abortSelectedTranscriptReplay();
			this.#abortRenderedTranscriptReplays();
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

	async #reconcileAfterReconnect(selectedChatId: string | null, epoch: number): Promise<void> {
		if (this.options.panels) {
			const visibleChatIds = [...this.options.panels.visibleChatIds()];
			const excludedBackgroundChatIds = new Set(visibleChatIds);
			const globalReconciliation = this.#reconcileGlobalState(selectedChatId, epoch);
			const visibleResume = this.#resumeRenderedChats(visibleChatIds, epoch);
			const backgroundResume = this.#resumeBackgroundChats(excludedBackgroundChatIds, epoch);
			const [, globalState] = await Promise.all([
				Promise.all([visibleResume, backgroundResume]),
				globalReconciliation,
			]);
			if (epoch === this.#reconnectEpoch) await globalState.controlRefresh;
			return;
		}
		let selectedResume: Promise<void> = Promise.resolve();
		if (selectedChatId) {
			this.options.chatState.transcriptCache.markStale(selectedChatId);
			selectedResume = this.#resumeSelectedChat(selectedChatId, epoch);
		}

		const excludedBackgroundChatIds = new Set(selectedChatId ? [selectedChatId] : []);
		const globalReconciliation = this.#reconcileGlobalState(selectedChatId, epoch);
		const backgroundResume = this.#resumeBackgroundChats(excludedBackgroundChatIds, epoch);
		const [, globalState] = await Promise.all([
			Promise.all([selectedResume, backgroundResume]),
			globalReconciliation,
		]);
		if (epoch !== this.#reconnectEpoch) return;
		await globalState.controlRefresh;
	}

	async #resumeRenderedChats(chatIds: readonly string[], epoch: number): Promise<void> {
		await Promise.all(chatIds.map((chatId) => this.#resumeRenderedChat(chatId, epoch)));
	}

	async #resumeRenderedChat(chatId: string, epoch: number): Promise<void> {
		const panels = this.options.panels;
		if (!panels) return;
		const cursor = panels.transcriptCache.readAppliedCursor(chatId);
		panels.markChatStale(chatId);
		if (!cursor?.transcriptViewId) {
			await this.#loadRenderedSnapshot(chatId, epoch);
			return;
		}
		const replayToken = panels.beginReconnectReplay(chatId, cursor.transcriptViewId);
		this.#renderedTranscriptReplays.set(chatId, replayToken);
		try {
			const message = await this.#replayTranscript({
				chatId,
				transcriptViewId: cursor.transcriptViewId,
				afterOrdinal: cursor.lastOrdinal,
				isCurrent: () =>
					epoch === this.#reconnectEpoch && panels.panelsForChat(chatId).length > 0,
				apply: (page) => panels.applyReconnectReplayPage(
					replayToken,
					chatId,
					{
						transcriptViewId: page.transcriptViewId,
						messages: page.messages,
						firstOrdinal: page.firstOrdinal,
						lastOrdinal: page.lastOrdinal,
						resendCandidates: page.resendCandidates,
						noticeRevision: panels.noticeRevisionFor(chatId),
					},
				) === 'applied',
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
			if (this.#renderedTranscriptReplays.get(chatId) === replayToken) {
				this.#renderedTranscriptReplays.delete(chatId);
			}
		}
	}

	async #loadRenderedSnapshot(chatId: string, epoch: number): Promise<void> {
		const panels = this.options.panels;
		if (!panels || epoch !== this.#reconnectEpoch) return;
		let loaded: boolean;
		try {
			loaded = await panels.loadChatSnapshot(chatId);
		} catch {
			if (epoch === this.#reconnectEpoch) panels.markChatStale(chatId);
			return;
		}
		if (
			!loaded
			|| epoch !== this.#reconnectEpoch
			|| panels.panelsForChat(chatId).length === 0
		) return;
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

	async #resumeSelectedChat(chatId: string, epoch: number): Promise<void> {
		const cursor = this.options.chatState.getCursor();
		const replayToken = this.options.chatState.beginReconnectReplay(
			chatId,
			cursor.transcriptViewId,
		);
		this.#selectedTranscriptReplay = { token: replayToken };
		try {
			const message = await this.#replayTranscript({
				chatId,
				transcriptViewId: cursor.transcriptViewId,
				afterOrdinal: cursor.lastOrdinal,
				isCurrent: () => (
					epoch === this.#reconnectEpoch && this.options.sessions.selectedChatId === chatId
				),
				apply: (page) => this.options.chatState.applyReconnectReplayPage(
					replayToken,
					chatId,
					page.transcriptViewId,
					page.messages,
					page.firstOrdinal,
					page.lastOrdinal,
					page.resendCandidates,
				) === 'applied',
			});
			if (!message) return;
			const replayResult = this.options.chatState.finishReconnectReplay(replayToken, chatId);
			if (replayResult === 'stale') return;
			if (replayResult !== 'applied') {
				await this.#loadSelectedSnapshot(chatId, epoch);
				return;
			}

			const currentCursor = this.options.chatState.getCursor();
			if (
				currentCursor.transcriptViewId !== cursor.transcriptViewId
				|| currentCursor.lastOrdinal < message.throughOrdinal
			) {
				await this.#loadSelectedSnapshot(chatId, epoch);
				return;
			}
			this.options.chatState.transcriptCache.markValidated(chatId);
		} catch {
			this.options.chatState.abortReconnectReplay(replayToken);
			if (epoch !== this.#reconnectEpoch || this.options.sessions.selectedChatId !== chatId) return;
			try {
				await this.#loadSelectedSnapshot(chatId, epoch);
			} catch {
				// Leaves the stale snapshot flag set so the next load revalidates.
			}
		} finally {
			this.options.chatState.abortReconnectReplay(replayToken);
			if (this.#selectedTranscriptReplay?.token === replayToken) {
				this.#selectedTranscriptReplay = null;
			}
		}
	}

	#abortSelectedTranscriptReplay(): void {
		const replay = this.#selectedTranscriptReplay;
		if (!replay) return;
		this.#selectedTranscriptReplay = null;
		this.options.chatState.abortReconnectReplay(replay.token);
	}

	#abortRenderedTranscriptReplays(): void {
		const panels = this.options.panels;
		if (!panels) return;
		panels.abortReconnectReplays();
		this.#renderedTranscriptReplays.clear();
	}

	async #loadSelectedSnapshot(chatId: string, epoch: number): Promise<void> {
		if (epoch !== this.#reconnectEpoch || this.options.sessions.selectedChatId !== chatId) return;
		await this.options.chatState.loadMessages(chatId, { purpose: 'activation' });
		if (epoch !== this.#reconnectEpoch || this.options.sessions.selectedChatId !== chatId) return;
		this.options.chatState.transcriptCache.markValidated(chatId);
	}

	async #resumeBackgroundChats(excludedChatIds: Set<string>, epoch: number): Promise<void> {
		const cursors = this.options
			.getBackgroundCursors()
			.filter((cursor) => !excludedChatIds.has(cursor.chatId))
			.filter((cursor) => cursor.transcriptViewId && cursor.lastOrdinal > 0)
			.slice(0, BACKGROUND_RESUME_LIMIT);

		let shouldRefresh = false;
		for (const cursor of cursors) {
			if (epoch !== this.#reconnectEpoch) return;
			try {
				const message = await this.#replayTranscript({
					chatId: cursor.chatId,
					transcriptViewId: cursor.transcriptViewId,
					afterOrdinal: cursor.lastOrdinal,
					isCurrent: () => epoch === this.#reconnectEpoch,
					apply: (page) => this.options.onBackgroundMessages?.(
						cursor.chatId,
						page.transcriptViewId,
						page.messages,
						page.firstOrdinal,
						page.lastOrdinal,
					),
				});
				if (!message) return;
				shouldRefresh = message.throughOrdinal > cursor.lastOrdinal || shouldRefresh;
			} catch {
				if (epoch !== this.#reconnectEpoch) return;
				this.options.markBackgroundStale(cursor.chatId);
				shouldRefresh = true;
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
		transcriptViewId: string,
		afterOrdinal: number,
		throughOrdinal?: number,
	): Promise<ChatSubscribedMessage> {
		const raw = await this.options.ws.sendRequest({
			type: 'chat-subscribe',
			chatId,
			transcriptViewId,
			afterOrdinal,
			...(throughOrdinal === undefined ? {} : { throughOrdinal }),
		});
		const message = parseServerWsMessage(raw);
		if (
			!(message instanceof ChatSubscribedMessage)
			|| message.chatId !== chatId
			|| message.transcriptViewId !== transcriptViewId
		) {
			throw new Error('Unexpected chat-subscribe response');
		}
		return message;
	}

	async #replayTranscript(input: TranscriptReplayInput): Promise<ChatSubscribedMessage | null> {
		let afterOrdinal = input.afterOrdinal;
		let throughOrdinal: number | undefined;
		while (input.isCurrent()) {
			const message = await this.#subscribe(
				input.chatId,
				input.transcriptViewId,
				afterOrdinal,
				throughOrdinal,
			);
			if (!input.isCurrent()) return null;
			if (message.firstOrdinal !== afterOrdinal + 1) {
				throw new Error('Transcript replay page does not continue its requested cursor');
			}
			if (throughOrdinal !== undefined && message.throughOrdinal !== throughOrdinal) {
				throw new Error('Transcript replay watermark changed during continuation');
			}
			throughOrdinal ??= message.throughOrdinal;
			if (
				message.nextAfterOrdinal < afterOrdinal
				|| (message.hasMore && message.nextAfterOrdinal === afterOrdinal)
			) {
				throw new Error('Transcript replay page did not advance its requested cursor');
			}

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
