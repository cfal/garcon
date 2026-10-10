import { updateSessionName } from '$lib/api/settings.js';
import * as m from '$lib/paraglide/messages.js';
import type { ChatSessionsPort, ChatSessionsStoreDeps } from './chat-sessions-contract.js';

interface ChatTitleControllerOptions {
	sessions: Pick<ChatSessionsPort, 'byId' | 'patchChat' | 'quietRefreshChats'>;
	deps: Pick<ChatSessionsStoreDeps, 'updateSessionName' | 'notifyError'>;
	readServerEntryGeneration: () => number;
}

export class ChatTitleController {
	#revision = 0;
	readonly #options: ChatTitleControllerOptions;

	constructor(options: ChatTitleControllerOptions) {
		this.#options = options;
	}

	get revision(): number {
		return this.#revision;
	}

	noteConfirmation(): void {
		// Same-value confirmations also supersede older in-flight list snapshots.
		this.#revision += 1;
	}

	async renameChat(chatId: string, newTitle: string): Promise<boolean> {
		const { sessions, deps, readServerEntryGeneration } = this.#options;
		const serverEntryGeneration = readServerEntryGeneration();
		const titleRevision = this.#revision;
		try {
			const renameRemoteChat = deps.updateSessionName ?? updateSessionName;
			const response = await renameRemoteChat(chatId, newTitle);
			const chat = sessions.byId[chatId];
			if (!chat) return true;

			const needsReconciliation =
				chat.title !== response.title &&
				(serverEntryGeneration !== readServerEntryGeneration() || titleRevision !== this.#revision);
			if (needsReconciliation) {
				await sessions.quietRefreshChats();
			} else {
				sessions.patchChat(chatId, { title: response.title });
			}
			return true;
		} catch (err) {
			console.error('[ChatSessionsStore] Rename failed:', err);
			deps.notifyError?.(m.notifications_rename_chat_failed());
			return false;
		}
	}
}
