// Coordinates shell-level state and imperative action dispatch.

export type SettingsTab = 'providers' | 'other-harnesses' | 'local' | 'remote';

function normalizeSettingsTab(value: string): SettingsTab {
	if (value === 'providers') return 'providers';
	if (value === 'other-harnesses') return 'other-harnesses';
	if (value === 'local') return 'local';
	if (value === 'remote') return 'remote';
	return 'providers';
}

export type RefreshChatsCallback = () => Promise<void> | void;

export interface NewChatDialogSeed {
	prefill?: string;
}

export class AppShellStore {
	showSettings = $state(false);
	settingsTab = $state<SettingsTab>('providers');
	sidebarOpen = $state(false);
	isMobile = $state(false);
	/** Height of the virtual keyboard in px, tracked via visualViewport. */
	keyboardHeight = $state(0);
	refreshChatsCallback = $state<RefreshChatsCallback | null>(null);
	quietRefreshChatsCallback = $state<RefreshChatsCallback | null>(null);
	/** Read-only project base path from server config. Set once on settings load. */
	projectBasePath = $state('/');

	/** Controls new-chat dialog visibility. */
	newChatDialogOpen = $state(false);
	/** One-shot seed data (e.g. prefill text) for the dialog form. */
	newChatDialogSeed = $state<NewChatDialogSeed | null>(null);

	// Callback sets for imperative action dispatch.
	#newChatCallbacks = new Set<() => void>();
	#recenterCallbacks = new Set<() => void>();
	#composerFocusCallbacks = new Set<() => void>();
	#renameSelectedCallbacks = new Set<() => void>();
	#deleteSelectedCallbacks = new Set<() => void>();
	#newChatDialogSeedCallbacks = new Set<() => void>();
	#sidebarSearchCallbacks = new Set<() => void>();

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

	registerRefreshChats(cb: RefreshChatsCallback): void {
		this.refreshChatsCallback = cb;
	}

	registerQuietRefreshChats(cb: RefreshChatsCallback): void {
		this.quietRefreshChatsCallback = cb;
	}

	refreshChats(): Promise<void> | void {
		return this.refreshChatsCallback?.();
	}

	/** Refreshes the chat list without showing the loading indicator. */
	quietRefreshChats(): Promise<void> | void {
		const cb = this.quietRefreshChatsCallback ?? this.refreshChatsCallback;
		return cb?.();
	}

	// Callback registration: returns an unsubscribe function.

	onNewChatRequested(cb: () => void): () => void {
		this.#newChatCallbacks.add(cb);
		return () => { this.#newChatCallbacks.delete(cb); };
	}

	onSidebarRecenterRequested(cb: () => void): () => void {
		this.#recenterCallbacks.add(cb);
		return () => { this.#recenterCallbacks.delete(cb); };
	}

	onComposerFocusRequested(cb: () => void): () => void {
		this.#composerFocusCallbacks.add(cb);
		return () => { this.#composerFocusCallbacks.delete(cb); };
	}

	onRenameSelectedChatRequested(cb: () => void): () => void {
		this.#renameSelectedCallbacks.add(cb);
		return () => { this.#renameSelectedCallbacks.delete(cb); };
	}

	onDeleteSelectedChatRequested(cb: () => void): () => void {
		this.#deleteSelectedCallbacks.add(cb);
		return () => { this.#deleteSelectedCallbacks.delete(cb); };
	}

	onNewChatDialogSeed(cb: () => void): () => void {
		this.#newChatDialogSeedCallbacks.add(cb);
		return () => { this.#newChatDialogSeedCallbacks.delete(cb); };
	}

	/** Requests sidebar to scroll the selected chat into view. */
	requestSidebarRecenterToSelected(): void {
		for (const cb of this.#recenterCallbacks) cb();
	}

	/** Requests sidebar to open rename for the currently selected chat. */
	requestRenameSelectedChat(): void {
		for (const cb of this.#renameSelectedCallbacks) cb();
	}

	/** Requests sidebar to open delete confirmation for the currently selected chat. */
	requestDeleteSelectedChat(): void {
		for (const cb of this.#deleteSelectedCallbacks) cb();
	}

	/** Requests shell navigation to the new-chat screen. */
	requestNewChat(): void {
		for (const cb of this.#newChatCallbacks) cb();
	}

	/** Requests focus on the active chat composer input. */
	requestComposerFocus(): void {
		for (const cb of this.#composerFocusCallbacks) cb();
	}

	/** Opens the new-chat dialog, optionally seeding it with prefill data. */
	openNewChatDialog(seed?: NewChatDialogSeed): void {
		this.newChatDialogSeed = seed ?? null;
		this.newChatDialogOpen = true;
		for (const cb of this.#newChatDialogSeedCallbacks) cb();
	}

	/** Closes the new-chat dialog without clearing the seed. */
	closeNewChatDialog(): void {
		this.newChatDialogOpen = false;
	}

	onSidebarSearchRequested(cb: () => void): () => void {
		this.#sidebarSearchCallbacks.add(cb);
		return () => { this.#sidebarSearchCallbacks.delete(cb); };
	}

	/** Toggles the sidebar search dialog via registered callbacks. */
	openSidebarSearch(): void {
		for (const cb of this.#sidebarSearchCallbacks) cb();
	}
}

export function createAppShellStore(): AppShellStore {
	return new AppShellStore();
}
