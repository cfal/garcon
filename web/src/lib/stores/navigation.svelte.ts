// Reactive navigation store using Svelte 5 runes. Tracks the active tab,
// input focus state, and pending rename requests. Chat selection has been
// moved to ChatSessionsStore as the single source of truth.

import type { AppTab } from '$lib/types/app';

export interface PendingRenameRequest {
	chatId: string;
	currentName: string;
}

export class NavigationStore {
	activeTab = $state<AppTab>('chat');
	isInputFocused = $state(false);
	pendingRenameRequest = $state<PendingRenameRequest | null>(null);

	setActiveTab(tab: AppTab): void {
		this.activeTab = tab;
	}

	setIsInputFocused(focused: boolean): void {
		this.isInputFocused = focused;
	}

	requestRename(request: PendingRenameRequest): void {
		this.pendingRenameRequest = request;
	}

	clearPendingRenameRequest(): void {
		this.pendingRenameRequest = null;
	}
}

export function createNavigationStore(): NavigationStore {
	return new NavigationStore();
}
