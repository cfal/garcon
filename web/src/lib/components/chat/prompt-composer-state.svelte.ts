// Ephemeral UI state for the PromptComposer that is not related to
// the chat message content itself. Extracted to keep the component
// focused on rendering and DOM interactions.

import type { FileMentionTrigger } from '$lib/chat/composer/file-mentions.js';
import type { SlashCommandTrigger } from '$lib/chat/composer/slash-commands.js';

export class PromptComposerUiState {
	showFileMenu = $state(false);
	fileQuery = $state('');
	fileMentionTrigger = $state<FileMentionTrigger | null>(null);
	showSlashMenu = $state(false);
	slashQuery = $state('');
	slashCommandTrigger = $state<SlashCommandTrigger | null>(null);
	previousChatId = $state<string | null>(null);

	setFileMentionTrigger(trigger: FileMentionTrigger | null): void {
		this.fileMentionTrigger = trigger;
		this.showFileMenu = Boolean(trigger);
		this.fileQuery = trigger?.query ?? '';
	}

	closeFileMenu(): void {
		this.setFileMentionTrigger(null);
	}

	setSlashCommandTrigger(trigger: SlashCommandTrigger | null): void {
		this.slashCommandTrigger = trigger;
		this.showSlashMenu = Boolean(trigger);
		this.slashQuery = trigger?.query ?? '';
	}

	closeSlashMenu(): void {
		this.setSlashCommandTrigger(null);
	}

	/** Resets ephemeral UI on chat switch. Returns true if the chat changed. */
	resetOnChatSwitch(nextChatId: string | null): boolean {
		if (nextChatId === this.previousChatId) return false;
		this.previousChatId = nextChatId;
		this.closeFileMenu();
		this.closeSlashMenu();
		return true;
	}
}
