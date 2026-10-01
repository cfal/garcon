// Coordinates shell-level state and imperative action dispatch.

import { untrack } from 'svelte';
import { createActionSignal } from '$lib/utils/action-signal';

// App tabs are stored in this browser; every other tab is server-owned.
const APP_SETTINGS_TABS = ['interface', 'shortcuts'] as const;

export const SETTINGS_TABS = [
	...APP_SETTINGS_TABS,
	'providers',
	'other-agents',
	'general',
	'automation',
	'notifications',
	'preambles',
	'scheduled-prompts',
	'snippets',
	'github',
	'executors',
] as const;
export type SettingsTab = (typeof SETTINGS_TABS)[number];

export function isServerSettingsTab(tab: SettingsTab): boolean {
	return !(APP_SETTINGS_TABS as readonly string[]).includes(tab);
}

function normalizeSettingsTab(value: string): SettingsTab {
	return (SETTINGS_TABS as readonly string[]).includes(value)
		? (value as SettingsTab)
		: 'interface';
}

export interface NewChatDialogSeed {
	prefill?: string;
}

/** Captured target for the per-chat preamble selection editor. */
export interface ChatPreambleSelectionTarget {
	readonly chatId: string;
	readonly transcriptViewId: string;
}

export class AppShellStore {
	showSettings = $state(false);
	showOnboardingWizard = $state(false);
	chatPreambleSelectionTarget = $state<ChatPreambleSelectionTarget | null>(null);
	settingsTab = $state<SettingsTab>('interface');
	sidebarOpen = $state(false);
	isMobile = $state(false);
	composerFocusRequestId = $state(0);
	/** Height of the virtual keyboard in px, tracked via visualViewport. */
	keyboardHeight = $state(0);
	/** Read-only project base path from server config. Set once on settings load. */
	projectBasePath = $state('/');

	/** Controls new-chat dialog visibility. */
	newChatDialogOpen = $state(false);
	/** One-shot seed data (e.g. prefill text) for the dialog form. */
	newChatDialogSeed = $state<NewChatDialogSeed | null>(null);

	#newChat = createActionSignal();
	#recenter = createActionSignal();
	#renameSelected = createActionSignal();
	#deleteSelected = createActionSignal();
	#newChatDialogSeed = createActionSignal();
	#sidebarSearch = createActionSignal();
	#settingsReturnFocus: (() => void) | null = null;
	#scheduledPromptReturnFocus = $state<(() => void) | null>(null);
	#focusReturnVersion = 0;

	openSettings(section: string = 'interface', returnFocus?: () => void): void {
		this.#focusReturnVersion += 1;
		this.#settingsReturnFocus = returnFocus ?? null;
		this.#scheduledPromptReturnFocus = null;
		this.showOnboardingWizard = false;
		this.showSettings = true;
		this.settingsTab = normalizeSettingsTab(section);
	}

	closeSettings(): void {
		if (this.scheduledPromptSuspended) {
			this.returnToScheduledPrompt();
			return;
		}
		this.showSettings = false;
		const returnFocus = this.#settingsReturnFocus;
		this.#settingsReturnFocus = null;
		this.#restoreFocus(returnFocus);
	}

	openOnboardingWizard(): void {
		this.#focusReturnVersion += 1;
		this.#settingsReturnFocus = null;
		this.#scheduledPromptReturnFocus = null;
		this.showSettings = false;
		this.showOnboardingWizard = true;
	}

	closeOnboardingWizard(): void {
		this.showOnboardingWizard = false;
	}

	get scheduledPromptSuspended(): boolean {
		return this.#scheduledPromptReturnFocus !== null;
	}

	openScheduledPromptPreambles(returnFocus: () => void): void {
		if (!this.showSettings || this.settingsTab !== 'scheduled-prompts') return;
		this.#focusReturnVersion += 1;
		this.#scheduledPromptReturnFocus = returnFocus;
		this.settingsTab = 'preambles';
	}

	returnToScheduledPrompt(): void {
		if (!this.scheduledPromptSuspended) return;
		const returnFocus = this.#scheduledPromptReturnFocus;
		this.#scheduledPromptReturnFocus = null;
		this.settingsTab = 'scheduled-prompts';
		this.#restoreFocus(returnFocus);
	}

	openChatPreambleSelection(chatId: string, transcriptViewId: string): void {
		this.chatPreambleSelectionTarget = { chatId, transcriptViewId };
	}

	closeChatPreambleSelection(): void {
		this.chatPreambleSelectionTarget = null;
	}

	setSettingsTab(tab: string): void {
		if (tab === 'scheduled-prompts' && this.scheduledPromptSuspended) {
			this.returnToScheduledPrompt();
			return;
		}
		this.settingsTab = normalizeSettingsTab(tab);
	}

	#restoreFocus(returnFocus: (() => void) | null): void {
		if (!returnFocus) return;
		const version = ++this.#focusReturnVersion;
		queueMicrotask(() => {
			if (version === this.#focusReturnVersion) returnFocus();
		});
	}

	setSidebarOpen(open: boolean): void {
		this.sidebarOpen = open;
	}

	// Callback registration: returns an unsubscribe function.

	onNewChatRequested(cb: () => void): () => void {
		return this.#newChat.subscribe(cb);
	}

	onSidebarRecenterRequested(cb: () => void): () => void {
		return this.#recenter.subscribe(cb);
	}

	onRenameSelectedChatRequested(cb: () => void): () => void {
		return this.#renameSelected.subscribe(cb);
	}

	onDeleteSelectedChatRequested(cb: () => void): () => void {
		return this.#deleteSelected.subscribe(cb);
	}

	onNewChatDialogSeed(cb: () => void): () => void {
		return this.#newChatDialogSeed.subscribe(cb);
	}

	/** Requests sidebar to scroll the selected chat into view. */
	requestSidebarRecenterToSelected(): void {
		this.#recenter.emit();
	}

	/** Requests sidebar to open rename for the currently selected chat. */
	requestRenameSelectedChat(): void {
		this.#renameSelected.emit();
	}

	/** Requests sidebar to open delete confirmation for the currently selected chat. */
	requestDeleteSelectedChat(): void {
		this.#deleteSelected.emit();
	}

	/** Requests shell navigation to the new-chat screen. */
	requestNewChat(): void {
		this.#newChat.emit();
	}

	/** Requests focus on the active chat composer input. */
	requestComposerFocus(): void {
		this.composerFocusRequestId = untrack(() => this.composerFocusRequestId) + 1;
	}

	/** Opens the new-chat dialog, optionally seeding it with prefill data. */
	openNewChatDialog(seed?: NewChatDialogSeed): void {
		this.newChatDialogSeed = seed ?? null;
		this.newChatDialogOpen = true;
		this.#newChatDialogSeed.emit();
	}

	/** Closes the new-chat dialog without clearing the seed. */
	closeNewChatDialog(): void {
		this.newChatDialogOpen = false;
	}

	onSidebarSearchRequested(cb: () => void): () => void {
		return this.#sidebarSearch.subscribe(cb);
	}

	/** Toggles the sidebar search dialog via registered callbacks. */
	openSidebarSearch(): void {
		this.#sidebarSearch.emit();
	}
}

export function createAppShellStore(): AppShellStore {
	return new AppShellStore();
}
