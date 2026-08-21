// Reactive chat lifecycle store using Svelte 5 runes. Owns selected-turn
// metadata such as status text; per-chat processing state owns tray visibility.

import * as m from '$lib/paraglide/messages.js';
import type { ChatProcessingPhase, ChatTurnRetryStatus } from '$shared/chat-types';

export type TurnStatus =
	| 'idle'
	| 'running'
	| 'stopping'
	| 'waiting-permission'
	| 'completed'
	| 'failed'
	| 'aborted';

export interface LoadingStatus {
	text: string;
	tokens: number;
	can_interrupt: boolean;
}

export interface LoadingStatusEntry extends LoadingStatus {
	id: string;
}

export interface StoppingSnapshot {
	turnStatus: TurnStatus;
	loadingStatusStack: LoadingStatusEntry[];
}

const PROVIDER_RETRY_STATUS_ID = '__provider-retry__';

function providerRetryText(retry: ChatTurnRetryStatus): string {
	const base = retry.attempt > 0
		? m.chat_loading_provider_retry({ attempt: retry.attempt, message: retry.message })
		: m.chat_loading_provider_retry_plain({ message: retry.message });
	const time = retry.nextAttemptAt ? formatRetryTime(retry.nextAttemptAt) : '';
	return time ? `${base} · ${m.chat_loading_provider_retry_next({ time })}` : base;
}

function formatRetryTime(iso: string): string {
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) return '';
	const sameDay = date.toDateString() === new Date().toDateString();
	return sameDay
		? date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
		: date.toLocaleString(undefined, {
				month: 'short',
				day: 'numeric',
				hour: '2-digit',
				minute: '2-digit',
			});
}

export class ConversationLifecycleState {
	turnStatus = $state<TurnStatus>('idle');
	loadingStatusStack = $state<LoadingStatusEntry[]>([]);
	currentChatId = $state<string | null>(null);
	isSystemChatChange = $state(false);
	#stoppingRequestId: string | null = null;
	#stoppingStartedAt: number | null = null;

	/** Returns the top (most recent) status entry, or null if empty. */
	get loadingStatus(): LoadingStatus | null {
		const stack = this.loadingStatusStack;
		return stack.length > 0 ? stack[stack.length - 1] : null;
	}

	setTurnStatus(status: TurnStatus): void {
		this.turnStatus = status;
	}

	/** Clears the stack and optionally pushes a single entry. */
	setLoadingStatus(status: LoadingStatus | null): void {
		if (status) {
			this.loadingStatusStack = [{ ...status, id: '__default__' }];
		} else {
			this.loadingStatusStack = [];
		}
	}

	/** Appends a status entry to the stack. Allows duplicate ids so
	 *  concurrent permission requests each get their own entry. */
	pushLoadingStatus(entry: LoadingStatusEntry): void {
		this.loadingStatusStack = [...this.loadingStatusStack, entry];
	}

	/** Removes the last entry with the given id from the stack. */
	popLoadingStatus(id: string): void {
		const idx = this.loadingStatusStack.findLastIndex((e) => e.id === id);
		if (idx === -1) return;
		this.loadingStatusStack = [
			...this.loadingStatusStack.slice(0, idx),
			...this.loadingStatusStack.slice(idx + 1),
		];
	}

	setCurrentChatId(id: string | null): void {
		this.currentChatId = id;
	}

	setIsSystemChatChange(v: boolean): void {
		this.isSystemChatChange = v;
	}

	/** Records that the selected turn is active without deciding tray visibility. */
	markTurnRunning(chatId?: string | null): void {
		this.turnStatus = 'running';
		if (chatId) this.setCurrentChatId(chatId);
	}

	/** Starts status metadata for an accepted assistant turn. */
	beginTurn(chatId: string): void {
		this.#stoppingRequestId = null;
		this.#stoppingStartedAt = null;
		this.markTurnRunning(chatId);
		this.setLoadingStatus({ text: m.chat_loading_processing(), tokens: 0, can_interrupt: true });
	}

	/** Clears selected-turn status metadata back to idle defaults. */
	clearTurnStatus(chatId: string): void {
		if (this.currentChatId !== chatId) return;
		this.#stoppingRequestId = null;
		this.#stoppingStartedAt = null;
		this.loadingStatusStack = [];
		this.turnStatus = 'idle';
	}

	beginStopping(chatId: string, requestId: string): StoppingSnapshot | null {
		if (this.currentChatId !== chatId) return null;
		const snapshot = {
			turnStatus: this.turnStatus,
			loadingStatusStack: this.loadingStatusStack.map((entry) => ({ ...entry })),
		};
		this.#stoppingRequestId = requestId;
		this.#stoppingStartedAt = Date.now();
		this.turnStatus = 'stopping';
		this.setLoadingStatus({
			text: m.chat_loading_stopping(),
			tokens: 0,
			can_interrupt: false,
		});
		return snapshot;
	}

	restoreStopping(chatId: string, requestId: string, snapshot: StoppingSnapshot | null): void {
		if (!snapshot || this.currentChatId !== chatId || this.#stoppingRequestId !== requestId) return;
		this.#stoppingRequestId = null;
		this.#stoppingStartedAt = null;
		this.turnStatus = snapshot.turnStatus;
		this.loadingStatusStack = snapshot.loadingStatusStack;
	}

	applyProcessingSnapshotPhase(
		chatId: string,
		phase: ChatProcessingPhase | null,
		retry: ChatTurnRetryStatus | null,
		sentAt: number | null,
	): void {
		if (
			phase === 'running'
			&& this.currentChatId === chatId
			&& this.#stoppingStartedAt !== null
			&& sentAt !== null
			&& sentAt <= this.#stoppingStartedAt
		) return;
		this.applyProcessingPhase(chatId, phase, retry);
	}

	applyProcessingPhase(
		chatId: string,
		phase: ChatProcessingPhase | null,
		retry: ChatTurnRetryStatus | null,
	): void {
		if (this.currentChatId !== chatId) return;
		if (phase === null) {
			this.clearTurnStatus(chatId);
			return;
		}
		if (phase === 'stopping') {
			this.turnStatus = 'stopping';
			this.setLoadingStatus({
				text: m.chat_loading_stopping(),
				tokens: 0,
				can_interrupt: false,
			});
			return;
		}
		this.#stoppingRequestId = null;
		this.#stoppingStartedAt = null;
		this.markTurnRunning(chatId);
		const current = this.loadingStatus;
		if (!current || current.text === m.chat_loading_stopping()) {
			this.setLoadingStatus({
				text: m.chat_loading_processing(),
				tokens: 0,
				can_interrupt: true,
			});
		}
		this.#applyProviderRetry(retry);
	}

	// Keeps the provider-retry entry on top of the status stack while the
	// upstream wait lasts; interruption stays available the whole time.
	#applyProviderRetry(retry: ChatTurnRetryStatus | null): void {
		this.popLoadingStatus(PROVIDER_RETRY_STATUS_ID);
		if (!retry) return;
		this.pushLoadingStatus({
			id: PROVIDER_RETRY_STATUS_ID,
			text: providerRetryText(retry),
			tokens: 0,
			can_interrupt: true,
		});
	}
}
