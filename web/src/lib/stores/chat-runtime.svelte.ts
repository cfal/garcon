// Reactive chat runtime store using Svelte 5 runes. Tracks chat list loading state.

export class ChatRuntimeStore {
	isLoadingChats = $state(true);

	setIsLoadingChats(loading: boolean): void {
		this.isLoadingChats = loading;
	}
}

export function createChatRuntimeStore(): ChatRuntimeStore {
	return new ChatRuntimeStore();
}
