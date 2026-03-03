// Ephemeral UI state for the PromptComposer that is not related to
// the chat message content itself. Extracted to keep the component
// focused on rendering and DOM interactions.

export class PromptComposerUiState {
	showFileMenu = $state(false);
	fileQuery = $state('');
	previousChatId = $state<string | null>(null);

	/** Resets ephemeral UI on chat switch. Returns true if the chat changed. */
	resetOnChatSwitch(nextChatId: string | null): boolean {
		if (nextChatId === this.previousChatId) return false;
		this.previousChatId = nextChatId;
		this.showFileMenu = false;
		this.fileQuery = '';
		return true;
	}
}
