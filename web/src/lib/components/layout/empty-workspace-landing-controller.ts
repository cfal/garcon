import type { ChatListLoadStatus } from '$lib/chat/sessions/chat-sessions-contract';

interface EmptyWorkspaceLandingSnapshot {
	chatListStatus: ChatListLoadStatus;
	chatListError: string | null;
	chatCount: number;
	isBareRoute: boolean;
	hasNavigationTarget: boolean;
	newChatDialogOpen: boolean;
	anotherDialogOpen: boolean;
}

export class EmptyWorkspaceLandingController {
	#handledEmptyWorkspace = false;

	constructor(private readonly openNewChat: () => void) {}

	observe(snapshot: EmptyWorkspaceLandingSnapshot): void {
		if (snapshot.chatCount > 0) {
			this.#handledEmptyWorkspace = false;
			return;
		}
		if (snapshot.newChatDialogOpen) {
			this.#handledEmptyWorkspace = true;
			return;
		}
		if (
			this.#handledEmptyWorkspace ||
			snapshot.chatListStatus !== 'ready' ||
			snapshot.chatListError !== null ||
			!snapshot.isBareRoute ||
			snapshot.hasNavigationTarget ||
			snapshot.anotherDialogOpen
		) return;

		// Consumes this empty period before opening, so dismissal never reopens it.
		this.#handledEmptyWorkspace = true;
		this.openNewChat();
	}
}
