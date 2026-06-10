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
	#needsFollowUpFetch = false;

	constructor(deps: AppShellControllerDeps) {
		this.deps = deps;
	}

	async #runFetch(showLoading: boolean): Promise<void> {
		if (showLoading) this.deps.setLoadingChats(true);
		try {
			const res = await listChats();
			this.deps.upsertFromServer(res.sessions ?? []);
		} catch (err) {
			const prefix = showLoading ? 'Failed to fetch chats' : 'Quiet refresh failed';
			console.error(`[AppShellController] ${prefix}:`, err);
		} finally {
			if (showLoading) this.deps.setLoadingChats(false);
		}
	}

	async #refresh(showLoading: boolean): Promise<void> {
		if (this.#inFlightFetch) {
			this.#needsFollowUpFetch = true;
			return this.#inFlightFetch;
		}

		this.#inFlightFetch = (async () => {
			let useLoadingState = showLoading;
			try {
				do {
					this.#needsFollowUpFetch = false;
					await this.#runFetch(useLoadingState);
					useLoadingState = false;
				} while (this.#needsFollowUpFetch);
			} finally {
				this.#inFlightFetch = null;
			}
		})();
		return this.#inFlightFetch;
	}

	/** Full chat list fetch with loading indicator. */
	async fetchChats(): Promise<void> {
		return this.#refresh(true);
	}

	/** Silent refresh without loading indicator. */
	async quietRefresh(): Promise<void> {
		return this.#refresh(false);
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
