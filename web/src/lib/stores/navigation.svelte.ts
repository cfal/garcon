// Reactive navigation store using Svelte 5 runes. Tracks the active app tab.

import type { AppTab } from '$lib/types/app';

export class NavigationStore {
	activeTab = $state<AppTab>('chat');

	setActiveTab(tab: AppTab): void {
		this.activeTab = tab;
	}
}

export function createNavigationStore(): NavigationStore {
	return new NavigationStore();
}
