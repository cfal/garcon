import { clearChat } from '$lib/api/chat-clear.js';
import { getChatSnapshot } from '$lib/api/chats.js';
import { ApiMutationOutcomeUnknownError } from '$lib/api/client.js';
import type { ClearChatRequest } from '$shared/chat-clear';
import type { SessionControllerDeps } from './conversation-session-controller-types.js';
import * as m from '$lib/paraglide/messages.js';

interface ClearTarget {
	readonly request: ClearChatRequest;
	readonly draftRevision: number | null;
}

export class ConversationClearController {
	#target = $state.raw<ClearTarget | null>(null);
	busy = $state(false);
	error = $state<string | null>(null);

	constructor(private readonly deps: {
		chatState: Pick<SessionControllerDeps['chatState'], 'getKnownHeadForChat' | 'appendLocalNoticeForChat' | 'recoverViewReplacement'>;
		composerState: Pick<SessionControllerDeps['composerState'], 'draftRevision' | 'clearAfterSubmit'>;
		sessions: Pick<SessionControllerDeps['sessions'], 'quietRefreshChats'>;
	}) {}

	get isOpen(): boolean {
		return this.#target !== null;
	}

	get targetKind(): ClearChatRequest['target']['kind'] {
		return this.#target?.request.target.kind ?? 'all';
	}

	requestBeforeMessage(chatId: string, head: { transcriptViewId: string | null; lastOrdinal: number }, ordinal: number): void {
		if (this.busy) return;
		if (!head.transcriptViewId || !Number.isSafeInteger(ordinal) || ordinal < 1 || ordinal > head.lastOrdinal) {
			this.deps.chatState.appendLocalNoticeForChat(chatId, 'error', m.chat_clear_not_loaded());
			return;
		}
		this.error = null;
		this.#target = {
			request: { chatId, transcriptViewId: head.transcriptViewId, lastOrdinal: head.lastOrdinal, target: { kind: 'before-message', ordinal } },
			draftRevision: null,
		};
	}

	request(chatId: string, ownsComposer: boolean): void {
		if (this.busy) return;
		const head = this.deps.chatState.getKnownHeadForChat(chatId);
		if (!head.transcriptViewId) {
			this.deps.chatState.appendLocalNoticeForChat(chatId, 'error', m.chat_clear_not_loaded());
			return;
		}
		this.error = null;
		this.#target = {
			request: { chatId, transcriptViewId: head.transcriptViewId, lastOrdinal: head.lastOrdinal, target: { kind: 'all' } },
			draftRevision: ownsComposer ? this.deps.composerState.draftRevision(chatId) : null,
		};
	}

	cancel(): void {
		if (this.busy) return;
		this.#target = null;
		this.error = null;
	}

	handleChatSwitch(chatId: string | null): void {
		if (this.#target?.request.chatId === chatId) return;
		this.#target = null;
		this.error = null;
	}

	async confirm(): Promise<void> {
		const target = this.#target;
		if (!target || this.busy) return;
		this.busy = true;
		try {
			await clearChat(target.request);
			const { chatId } = target.request;
			if (target.draftRevision !== null && this.deps.composerState.draftRevision(chatId) === target.draftRevision) {
				this.deps.composerState.clearAfterSubmit(chatId);
			}
			this.#target = null;
			await this.#recoverViewReplacement(target.request);
		} catch (error) {
			if (error instanceof ApiMutationOutcomeUnknownError) {
				this.#target = null;
				await this.#reconcileUnknownOutcome(target.request);
			}
			const message = error instanceof Error ? error.message : String(error);
			if (this.#target) this.error = message;
			else this.deps.chatState.appendLocalNoticeForChat(target.request.chatId, 'error', message);
		} finally {
			this.busy = false;
		}
	}

	async #recoverViewReplacement(request: ClearChatRequest): Promise<void> {
		try {
			await this.deps.chatState.recoverViewReplacement(request.chatId, request.transcriptViewId);
		} finally {
			await this.deps.sessions.quietRefreshChats();
		}
	}

	async #reconcileUnknownOutcome(request: ClearChatRequest): Promise<void> {
		try {
			const snapshot = await getChatSnapshot(request.chatId, 1);
			if (snapshot.chat.id !== request.chatId || snapshot.transcript.availability !== 'available') return;
			if (snapshot.transcript.transcriptViewId === request.transcriptViewId) return;
			await this.#recoverViewReplacement(request);
		} catch {
			// A failed read cannot establish whether the mutation committed.
		}
	}
}
