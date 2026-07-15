// Reactive chat lifecycle store using Svelte 5 runes. Owns selected-turn
// metadata such as status text; per-chat processing state owns tray visibility.

import * as m from '$lib/paraglide/messages.js';

export type TurnStatus =
	| 'idle'
	| 'running'
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

export class ConversationLifecycleState {
	turnStatus = $state<TurnStatus>('idle');
	loadingStatusStack = $state<LoadingStatusEntry[]>([]);
	currentChatId = $state<string | null>(null);
	isSystemChatChange = $state(false);

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
		this.markTurnRunning(chatId);
		this.setLoadingStatus({ text: m.chat_loading_processing(), tokens: 0, can_interrupt: true });
	}

	/** Clears selected-turn status metadata back to idle defaults. */
	clearTurnStatus(): void {
		this.loadingStatusStack = [];
		this.turnStatus = 'idle';
	}
}
