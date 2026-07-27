// Reactive chat lifecycle store using Svelte 5 runes. Owns selected-turn
// metadata such as status text; per-chat processing state owns tray visibility.

import * as m from '$lib/paraglide/messages.js';
import type { ChatProcessingPhase } from '$shared/chat-types';

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

export class ConversationLifecycleState {
	turnStatus = $state<TurnStatus>('idle');
	loadingStatusStack = $state<LoadingStatusEntry[]>([]);
	currentChatId = $state<string | null>(null);
	isSystemChatChange = $state(false);
	#stoppingRequestId: string | null = null;

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
		this.markTurnRunning(chatId);
		this.setLoadingStatus({ text: m.chat_loading_processing(), tokens: 0, can_interrupt: true });
	}

	/** Clears selected-turn status metadata back to idle defaults. */
	clearTurnStatus(chatId: string): void {
		if (this.currentChatId !== chatId) return;
		this.#stoppingRequestId = null;
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
		this.turnStatus = snapshot.turnStatus;
		this.loadingStatusStack = snapshot.loadingStatusStack;
	}

	applyProcessingPhase(chatId: string, phase: ChatProcessingPhase | null): void {
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
		this.markTurnRunning(chatId);
		const current = this.loadingStatus;
		if (!current || current.text === m.chat_loading_stopping()) {
			this.setLoadingStatus({
				text: m.chat_loading_processing(),
				tokens: 0,
				can_interrupt: true,
			});
		}
	}
}
