// Reactive chat runtime store using Svelte 5 runes. Tracks loading
// state and progress for the chat list. Per-chat processing state
// has moved to ChatSessionsStore.isProcessing.

import type { LoadingProgress } from '$lib/types/app';

export class ChatRuntimeStore {
	isLoadingChats = $state(true);
	loadingProgress = $state<LoadingProgress | null>(null);
	externalMessageUpdate = $state(0);

	setIsLoadingChats(loading: boolean): void {
		this.isLoadingChats = loading;
	}

	setLoadingProgress(progress: LoadingProgress | null): void {
		this.loadingProgress = progress;
	}

	/** Bumps a counter so consumers can react to external message updates. */
	incrementExternalMessageUpdate(): void {
		this.externalMessageUpdate += 1;
	}
}

export function createChatRuntimeStore(): ChatRuntimeStore {
	return new ChatRuntimeStore();
}
