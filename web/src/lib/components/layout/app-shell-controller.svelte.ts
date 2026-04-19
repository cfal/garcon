// Extracts API orchestration from AppShell.svelte. Handles chat list
// fetching, deletion, and renaming so the component only coordinates
// UI state and navigation.

import { listChats, deleteChat } from '$lib/api/chats.js';
import { updateSessionName } from '$lib/api/settings.js';
import type { ChatSession } from '$lib/types/session.js';

export interface AppShellControllerDeps {
	upsertFromServer: (sessions: ChatSession[]) => void;
	setLoadingChats: (loading: boolean) => void;
}

export class AppShellController {
	private deps: AppShellControllerDeps;
	#inFlightFetch: Promise<void> | null = null;

	constructor(deps: AppShellControllerDeps) {
		this.deps = deps;
	}

	/** Full chat list fetch with loading indicator. */
	async fetchChats(): Promise<void> {
		if (this.#inFlightFetch) return this.#inFlightFetch;

		this.deps.setLoadingChats(true);
		this.#inFlightFetch = (async () => {
			try {
				const res = await listChats();
				this.deps.upsertFromServer(res.sessions ?? []);
			} catch (err) {
				console.error('[AppShellController] Failed to fetch chats:', err);
			} finally {
				this.deps.setLoadingChats(false);
				this.#inFlightFetch = null;
			}
		})();
		return this.#inFlightFetch;
	}

	/** Silent refresh without loading indicator. */
	async quietRefresh(): Promise<void> {
		if (this.#inFlightFetch) return this.#inFlightFetch;

		this.#inFlightFetch = (async () => {
			try {
				const res = await listChats();
				this.deps.upsertFromServer(res.sessions ?? []);
			} catch (err) {
				console.error('[AppShellController] Quiet refresh failed:', err);
			} finally {
				this.#inFlightFetch = null;
			}
		})();
		return this.#inFlightFetch;
	}

	/** Fires the server-side delete in the background. Callers are expected
	 *  to have already applied the optimistic UI removal; on failure we
	 *  refetch so the chat list reconverges with the server. */
	async deleteChat(chatId: string): Promise<void> {
		try {
			await deleteChat(chatId);
		} catch (err) {
			console.error('[AppShellController] Delete failed:', err);
			// Rehydrate so the chat that failed to delete reappears.
			void this.quietRefresh();
		}
	}

	async renameChat(chatId: string, newTitle: string): Promise<void> {
		try {
			await updateSessionName(chatId, newTitle);
		} catch (err) {
			console.error('[AppShellController] Rename failed:', err);
		}
	}
}
