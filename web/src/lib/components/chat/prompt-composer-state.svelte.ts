// Ephemeral UI state for the PromptComposer that is not related to
// the chat message content itself. Extracted to keep the component
// focused on rendering and DOM interactions.

import type { FileMentionTrigger } from '$lib/chat/file-mentions';

export class PromptComposerUiState {
	showFileMenu = $state(false);
	fileQuery = $state('');
	fileMentionTrigger = $state<FileMentionTrigger | null>(null);
	previousChatId = $state<string | null>(null);

	setFileMentionTrigger(trigger: FileMentionTrigger | null): void {
		this.fileMentionTrigger = trigger;
		this.showFileMenu = Boolean(trigger);
		this.fileQuery = trigger?.query ?? '';
	}

	closeFileMenu(): void {
		this.setFileMentionTrigger(null);
	}

	/** Resets ephemeral UI on chat switch. Returns true if the chat changed. */
	resetOnChatSwitch(nextChatId: string | null): boolean {
		if (nextChatId === this.previousChatId) return false;
		this.previousChatId = nextChatId;
		this.closeFileMenu();
		return true;
	}
}
