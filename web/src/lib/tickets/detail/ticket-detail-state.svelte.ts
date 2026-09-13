import type { TicketActivity, TicketDetail, TicketSequencePage } from '$shared/tickets';
import type { TicketsApi } from '$lib/api/tickets.js';
import { requireTicketVersion } from '../catalog/ticket-collection.js';
import type { TicketDraftState } from '../drafts/ticket-draft-state.svelte.js';

export class TicketDetailState {
	selectedId = $state<string | null>(null);
	current = $state.raw<TicketDetail | null>(null);
	history = $state.raw<TicketSequencePage<TicketActivity> | null>(null);
	tab = $state<'comments' | 'activity'>('comments');
	error = $state<string | null>(null);
	historyError = $state<string | null>(null);
	newComments = $state(false);
	fieldsDraft = $state.raw<TicketDraftState | null>(null);
	commentEditDraft = $state.raw<TicketDraftState | null>(null);
	commentsBefore: number | undefined;
	commentsLimit = 50;
	historyBefore: number | undefined;
	historyLimit = 50;
	#cache = new Map<string, TicketDetail>();

	select(ticketId: string | null): void {
		if (ticketId === this.selectedId) return;
		this.selectedId = ticketId;
		this.fieldsDraft = null;
		this.commentEditDraft = null;
		this.current = ticketId ? (this.#cache.get(ticketId) ?? null) : null;
		this.history = null;
		this.historyError = null;
		this.tab = 'comments';
		this.error = null;
		this.newComments = false;
		this.latest();
	}

	latest(): void {
		this.commentsBefore = undefined;
		this.commentsLimit = 50;
		this.historyBefore = undefined;
		this.historyLimit = 50;
	}

	async load(
		api: Pick<TicketsApi, 'read' | 'comments'>,
		ticketId: string,
		storeId: string,
		revision: number,
		signal: AbortSignal,
	): Promise<TicketDetail> {
		const limit = this.commentsLimit;
		let detail = await api.read(
			{
				ticketId,
				expectedCollectionRevision: revision,
				commentLimit: limit,
				...(this.commentsBefore === undefined
					? {}
					: { beforeCommentSequence: this.commentsBefore }),
			},
			signal,
		);
		requireTicketVersion(detail, storeId, revision);
		while (detail.comments.items.length < limit && detail.comments.nextBeforeSequence !== null) {
			const page = await api.comments(
				{
					ticketId,
					beforeSequence: detail.comments.nextBeforeSequence,
					expectedCollectionRevision: revision,
					limit: limit - detail.comments.items.length,
				},
				signal,
			);
			requireTicketVersion(page, storeId, revision);
			if (!page.items.length) throw new Error('Empty comment continuation');
			detail = {
				...detail,
				comments: { ...page, items: [...page.items, ...detail.comments.items] },
			};
		}
		return detail;
	}

	accept(detail: TicketDetail): void {
		const prior = this.#cache.get(detail.ticket.id);
		if (
			prior &&
			prior.storeId === detail.storeId &&
			prior.collectionRevision > detail.collectionRevision
		)
			return;
		this.#cache.delete(detail.ticket.id);
		this.#cache.set(detail.ticket.id, detail);
		while (this.#cache.size > 20) this.#cache.delete(this.#cache.keys().next().value!);
		if (detail.ticket.id !== this.selectedId) return;
		const lastComment = this.current?.comments.items.at(-1)?.sequence ?? 0;
		if (this.current && (detail.comments.items.at(-1)?.sequence ?? 0) > lastComment)
			this.newComments = true;
		this.current = detail;
		this.error = null;
	}

	invalidate(ticketIds?: readonly string[]): void {
		if (ticketIds) for (const id of ticketIds) this.#cache.delete(id);
		else this.#cache.clear();
	}

	reset(): void {
		this.latest();
		this.#cache.clear();
		this.selectedId = null;
		this.fieldsDraft = null;
		this.commentEditDraft = null;
		this.current = null;
		this.history = null;
		this.historyError = null;
		this.error = null;
		this.newComments = false;
	}
	get cacheSize(): number {
		return this.#cache.size;
	}
}
