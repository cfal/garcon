import type { ChatArchiveMutation } from '$lib/chat/sessions/chat-sessions-contract.js';
import type { ChatSessionsStore } from '$lib/chat/sessions/chat-sessions.svelte.js';
import type { NotificationAction, NotificationsStore } from '$lib/stores/notifications.svelte.js';
import * as m from '$lib/paraglide/messages.js';

type ArchiveSessions = Pick<
	ChatSessionsStore,
	'byId' | 'isArchiveMutationPending' | 'startArchivingChats' | 'startUnarchivingChats'
>;
const noticeKey = 'archive-undo';

export class ArchiveUndoController {
	#generation = 0;
	#targets: readonly string[] = [];
	constructor(
		private readonly sessions: ArchiveSessions,
		private readonly notifications: NotificationsStore,
	) {}

	startArchivingChats(chatIds: readonly string[]): ChatArchiveMutation {
		const mutation = this.sessions.startArchivingChats(chatIds);
		if (mutation.chatIds.length === 0) return mutation;
		const generation = ++this.#generation;
		this.#targets = [];
		this.notifications.dismissKey(noticeKey);
		const offerUndo = () => {
			if (generation !== this.#generation) return;
			const archivedIds = mutation.chatIds.filter(
				(id) => this.sessions.byId[id]?.isArchived && !this.sessions.isArchiveMutationPending(id),
			);
			if (archivedIds.length > 0) this.#showUndo(archivedIds, generation);
		};
		void mutation.completion.then(offerUndo, offerUndo);
		return mutation;
	}

	startUnarchivingChats(chatIds: readonly string[]): ChatArchiveMutation {
		this.#invalidateNotice();
		return this.sessions.startUnarchivingChats(chatIds);
	}

	reconcile(): void {
		const records = this.sessions.byId;
		const notice = this.notifications.items.find((item) => item.key === noticeKey);
		if (this.#targets.length === 0) return;
		if (!notice || this.#targets.some((id) => !records[id]?.isArchived)) this.#invalidateNotice();
	}

	#showUndo(chatIds: readonly string[], generation: number): void {
		this.#targets = chatIds;
		let consumed = false;
		const action: NotificationAction = {
			label: m.archive_undo_action(),
			onClick: () => {
				if (
					consumed ||
					generation !== this.#generation ||
					!this.notifications.items.some(
						(item) =>
							item.key === noticeKey && item.expiresAt !== null && item.expiresAt > Date.now(),
					)
				)
					return;
				consumed = true;
				const targets = chatIds.filter(
					(id) => this.sessions.byId[id]?.isArchived && !this.sessions.isArchiveMutationPending(id),
				);
				if (targets.length === 0) return;
				const restore = this.sessions.startUnarchivingChats(targets);
				void restore.completion.catch((error) => {
					this.notifications.error(
						m.archive_undo_failed({
							detail: error instanceof Error ? error.message : String(error),
						}),
					);
				});
			},
		};
		this.notifications.info(
			chatIds.length === 1
				? m.archive_undo_notice_one()
				: m.archive_undo_notice({ count: chatIds.length }),
			{
				key: noticeKey,
				action,
			},
		);
	}

	destroy(): void {
		this.#invalidateNotice();
	}

	#invalidateNotice(): void {
		this.#targets = [];
		this.#generation++;
		this.notifications.dismissKey(noticeKey);
	}
}
