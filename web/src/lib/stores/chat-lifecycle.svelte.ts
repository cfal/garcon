// Reactive chat lifecycle store using Svelte 5 runes. Manages the
// current turn's execution state: loading indicators, abort capability,
// and status text.

export type TurnStatus = 'idle' | 'running' | 'waiting-permission' | 'completed' | 'failed' | 'aborted';

export interface LoadingStatus {
	text: string;
	tokens: number;
	can_interrupt: boolean;
}

export interface LoadingStatusEntry extends LoadingStatus {
	id: string;
}

export class ChatLifecycleStore {
	turnStatus = $state<TurnStatus>('idle');
	isLoading = $state(false);
	canAbort = $state(false);
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

	setIsLoading(loading: boolean): void {
		this.isLoading = loading;
	}

	setCanAbort(canAbort: boolean): void {
		this.canAbort = canAbort;
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

	/** Sets loading and turn status to running in a single operation. */
	activateLoading(): void {
		this.isLoading = true;
		this.turnStatus = 'running';
	}

	/** Resets all loading-related fields back to idle defaults. */
	clearLoading(): void {
		this.isLoading = false;
		this.canAbort = false;
		this.loadingStatusStack = [];
		this.turnStatus = 'idle';
	}
}

export function createChatLifecycleStore(): ChatLifecycleStore {
	return new ChatLifecycleStore();
}
