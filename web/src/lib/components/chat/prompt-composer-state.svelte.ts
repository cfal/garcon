// Ephemeral UI state for the PromptComposer that is not related to
// the chat message content itself. Extracted to keep the component
// focused on rendering and DOM interactions.

import {
	findFileMentionTrigger,
	type FileMentionTrigger,
} from '$lib/chat/composer/file-mentions.js';
import {
	findSlashCommandTrigger,
	type SlashCommandTrigger,
} from '$lib/chat/composer/slash-commands.js';
import { SnippetPaletteTriggerState } from '$lib/chat/composer/snippet-palette-trigger-state.svelte.js';
import { findSnippetTrigger } from '$lib/chat/composer/snippet-trigger.js';
import type { ComposerEditorSelection } from '$lib/chat/composer/composer-editor-selection.js';

export class PromptComposerUiState {
	showFileMenu = $state(false);
	fileQuery = $state('');
	fileMentionTrigger = $state<FileMentionTrigger | null>(null);
	showSlashMenu = $state(false);
	slashQuery = $state('');
	slashCommandTrigger = $state<SlashCommandTrigger | null>(null);
	readonly snippetPalette = new SnippetPaletteTriggerState();
	previousChatId = $state<string | null>(null);
	composerEditorOpen = $state(false);
	composerEditorChatId = $state<string | null>(null);
	composerEditorFocusRequestId = $state(0);
	composerEditorSelection = $state<ComposerEditorSelection>({ anchor: 0, head: 0 });

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

	updateTriggers(value: string, caret: number, snippetTrigger: unknown, isComposing = false): void {
		const fileTrigger = findFileMentionTrigger(value, caret);
		this.setFileMentionTrigger(fileTrigger);
		if (fileTrigger) {
			this.setSlashCommandTrigger(null);
			this.snippetPalette.updateDetectedTrigger(null, value);
			return;
		}

		this.setSlashCommandTrigger(findSlashCommandTrigger(value, caret));
		if (isComposing) return;
		this.snippetPalette.updateDetectedTrigger(
			findSnippetTrigger(value, caret, snippetTrigger),
			value,
		);
	}

	openComposerEditor(chatId: string, selection: ComposerEditorSelection): void {
		if (this.composerEditorOpen && this.composerEditorChatId === chatId) {
			this.composerEditorFocusRequestId += 1;
			return;
		}
		this.composerEditorChatId = chatId;
		this.composerEditorSelection = selection;
		this.composerEditorFocusRequestId += 1;
		this.composerEditorOpen = true;
	}

	updateComposerEditorSelection(chatId: string, selection: ComposerEditorSelection): void {
		if (!this.composerEditorOpen || this.composerEditorChatId !== chatId) return;
		this.composerEditorSelection = selection;
	}

	closeComposerEditor(): void {
		this.composerEditorOpen = false;
		this.composerEditorChatId = null;
	}

	/** Resets ephemeral UI on chat switch. Returns true if the chat changed. */
	resetOnChatSwitch(nextChatId: string | null): boolean {
		if (nextChatId === this.previousChatId) return false;
		this.previousChatId = nextChatId;
		this.closeFileMenu();
		this.closeSlashMenu();
		this.snippetPalette.reset();
		this.closeComposerEditor();
		return true;
	}
}
