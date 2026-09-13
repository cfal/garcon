import { ApiError } from '$lib/api/client.js';
import { navigateToSearchResult } from '$lib/api/chats.js';
import type { TranscriptNavigationController } from '$lib/chat/actions/transcript-navigation-controller.js';
import type { TranscriptRowTarget } from '$lib/chat/transcript/transcript-row-navigation.js';
import type { WorkspaceWindowId } from '$lib/workspace/surface-types.js';
import * as m from '$lib/paraglide/messages.js';

export interface SearchResultSelection {
	readonly chatId: string;
	readonly target: TranscriptRowTarget | null;
}

export interface SearchResultNavigationPort {
	open(selection: SearchResultSelection): Promise<void>;
	cancel(): void;
}

export interface SearchResultNavigationDeps {
	navigation: Pick<TranscriptNavigationController, 'open'>;
	notifications: { info(message: string): void; error(message: string): void };
	discardStaleResult(target: TranscriptRowTarget): void;
	validate?: typeof navigateToSearchResult;
}

export class SearchResultNavigationController {
	constructor(private readonly deps: SearchResultNavigationDeps) {}

	async open(selection: SearchResultSelection, host: WorkspaceWindowId | 'mobile'): Promise<void> {
		const { chatId } = selection;
		const target = selection.target ? { ...selection.target } : null;
		await this.deps.navigation.open({
			chatId,
			host,
			ownsSource: () => true,
			resolve: async (signal) => {
				if (!target) return { kind: 'chat-only' };
				if (target.chatId !== chatId) throw new Error('Search target does not match its chat');
				try {
					const validated = await (this.deps.validate ?? navigateToSearchResult)(target, {
						signal,
					});
					if (validated.chatId !== chatId || validated.ordinal !== target.ordinal)
						throw new Error('Search navigation response does not match its target');
					return { kind: 'found', target };
				} catch (error) {
					if (error instanceof ApiError && error.errorCode === 'SEARCH_RESULT_STALE')
						return { kind: 'view-changed' };
					throw error;
				}
			},
			onResult: (result) => {
				if (result === 'view-changed' && target) {
					this.deps.discardStaleResult(target);
					this.deps.notifications.info(m.sidebar_search_target_reloaded());
				} else if (result === 'unavailable') {
					this.deps.notifications.info(m.sidebar_search_target_unavailable());
				}
			},
			onError: (error) => {
				const message =
					error instanceof ApiError && error.errorCode === 'SESSION_NOT_FOUND'
						? m.sidebar_search_target_chat_missing()
						: m.sidebar_search_target_failed();
				this.deps.notifications.error(message);
			},
		});
	}
}
