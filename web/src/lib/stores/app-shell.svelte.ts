// Coordinates shell-level state and imperative action dispatch.

import { untrack } from 'svelte';
import { createActionSignal } from '$lib/utils/action-signal';

export type SettingsTab = 'providers' | 'other-agents' | 'local' | 'remote';

function normalizeSettingsTab(value: string): SettingsTab {
	if (value === 'providers') return 'providers';
	if (value === 'other-agents') return 'other-agents';
	if (value === 'local') return 'local';
	if (value === 'remote') return 'remote';
	return 'providers';
}

export interface NewChatDialogSeed {
	prefill?: string;
}

export class AppShellStore {
	showSettings = $state(false);
	settingsTab = $state<SettingsTab>('providers');
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
	#composerFocus = createActionSignal();
	#renameSelected = createActionSignal();
	#deleteSelected = createActionSignal();
	#newChatDialogSeed = createActionSignal();
	#sidebarSearch = createActionSignal();

	openSettings(section: string = 'providers'): void {
		this.showSettings = true;
		this.settingsTab = normalizeSettingsTab(section);
	}

	closeSettings(): void {
		this.showSettings = false;
	}

	setSettingsTab(tab: string): void {
		this.settingsTab = normalizeSettingsTab(tab);
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

	onComposerFocusRequested(cb: () => void): () => void {
		return this.#composerFocus.subscribe(cb);
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
		this.#composerFocus.emit();
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
