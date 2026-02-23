// Reactive app shell store using Svelte 5 runes. Controls settings
// panel visibility, sidebar dimensions, and callback registration
// for imperative action dispatch.

const SIDEBAR_KEY = 'pref_sidebarWidth';
const SIDEBAR_DEFAULT_WIDTH = 320;

function readInitialSidebarWidth(): number {
	if (typeof window === 'undefined') return SIDEBAR_DEFAULT_WIDTH;
	try {
		const raw = localStorage.getItem(SIDEBAR_KEY);
		if (raw === null) return SIDEBAR_DEFAULT_WIDTH;
		const stored = Number(raw);
		return Number.isFinite(stored) && stored > 0 ? stored : SIDEBAR_DEFAULT_WIDTH;
	} catch {
		return SIDEBAR_DEFAULT_WIDTH;
	}
}

export type RefreshChatsCallback = () => void;

export interface NewChatDialogSeed {
	prefill?: string;
}

export class AppShellStore {
	showSettings = $state(false);
	settingsInitialSection = $state<string>('agents');
	sidebarWidth = $state(SIDEBAR_DEFAULT_WIDTH);
	sidebarOpen = $state(false);
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
	#newChatDialogSeedCallbacks = new Set<() => void>();

	constructor() {
		this.sidebarWidth = readInitialSidebarWidth();
	}

	openSettings(section: string = 'agents'): void {
		this.showSettings = true;
		this.settingsInitialSection = section;
	}

	closeSettings(): void {
		this.showSettings = false;
	}

	setSidebarWidth(width: number): void {
		this.sidebarWidth = width;
		try {
			localStorage.setItem(SIDEBAR_KEY, String(width));
		} catch {
			// Storage full or unavailable
		}
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

	refreshChats(): void {
		if (this.refreshChatsCallback) this.refreshChatsCallback();
	}

	/** Refreshes the chat list without showing the loading indicator. */
	quietRefreshChats(): void {
		const cb = this.quietRefreshChatsCallback ?? this.refreshChatsCallback;
		if (cb) cb();
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
}

export function createAppShellStore(): AppShellStore {
	return new AppShellStore();
}
