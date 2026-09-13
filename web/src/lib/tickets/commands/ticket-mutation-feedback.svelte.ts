import type { Ticket, TicketDetail, TicketListQuery, TicketSummary } from '$shared/tickets';
import type { TicketMutationPayload } from '$shared/ticket-commands';
import type {
	TicketDraftState,
	TicketDraftConfirmation,
} from '../drafts/ticket-draft-state.svelte.js';
import {
	ticketWindowLimit,
	type TicketCollection,
	type TicketWindowKey,
} from '../catalog/ticket-collection.js';

interface ConfirmedTicket {
	readonly ticket: Ticket;
	readonly collectionRevision: number;
}
type PresentedTicket = TicketDetail['ticket'] | TicketSummary;

function previewMutation<T extends PresentedTicket>(ticket: T, payload: TicketMutationPayload): T {
	if (
		!('ticketId' in payload) ||
		payload.ticketId !== ticket.id ||
		!('expectedRevision' in payload) ||
		payload.expectedRevision !== ticket.revision
	)
		return ticket;
	switch (payload.action) {
		case 'update':
			return { ...ticket, ...payload.patch };
		case 'reopen':
			return { ...ticket, status: 'open', resolution: null };
		case 'release':
			return { ...ticket, assignee: null };
		default:
			return ticket;
	}
}

// Pending previews never enter the authoritative collection or its pagination cursors.
export class TicketMutationFeedback {
	#confirmed = $state.raw<readonly ConfirmedTicket[]>([]);
	#saved = $state(false);
	#timer: ReturnType<typeof setTimeout> | null = null;
	constructor(private readonly drafts: () => readonly TicketDraftState[]) {}

	get status(): 'saving' | 'saved' | null {
		if (this.drafts().some((draft) => draft.pending)) return 'saving';
		if (this.drafts().some((draft) => draft.error)) return null;
		return this.#saved ? 'saved' : null;
	}
	busy(ticketId: string): boolean {
		return (
			this.#confirmed.some(({ ticket }) => ticket.id === ticketId) ||
			this.drafts().some((draft) => draft.pending && draft.current.ticketId === ticketId)
		);
	}
	confirm({ result, reused, draft }: TicketDraftConfirmation, knownRevision: number): void {
		if (
			!reused &&
			(draft.current.kind === 'fields' || draft.current.kind === 'mutation') &&
			result.collectionRevision >= knownRevision
		) {
			this.#confirmed = [
				...this.#confirmed.filter(({ ticket }) => ticket.id !== result.ticket.id),
				{ ticket: result.ticket, collectionRevision: result.collectionRevision },
			];
		}
		this.#saved = true;
		if (this.#timer !== null) clearTimeout(this.#timer);
		this.#timer = setTimeout(() => {
			this.#saved = false;
			this.#timer = null;
		}, 1800);
	}
	reconcile(revision: number): void {
		this.#confirmed = this.#confirmed.filter((entry) => entry.collectionRevision > revision);
	}
	reset(): void {
		this.#confirmed = [];
		this.#saved = false;
		if (this.#timer !== null) clearTimeout(this.#timer);
		this.#timer = null;
	}
	ticket<T extends PresentedTicket>(ticket: T): T {
		const confirmed = this.#confirmed.find((entry) => entry.ticket.id === ticket.id);
		let projected = ticket;
		if (confirmed && confirmed.ticket.revision >= ticket.revision)
			projected = { ...ticket, ...confirmed.ticket };
		for (const draft of this.drafts()) {
			if (draft.pending && draft.current.frozen)
				projected = previewMutation(projected, draft.current.frozen.request.payload);
		}
		return projected;
	}
	collection(collection: TicketCollection | null, query: TicketListQuery): TicketCollection | null {
		if (!collection) return null;
		const keys = Object.keys(collection.windows) as TicketWindowKey[];
		const changes = Object.values(collection.windows)
			.flatMap((window) => window?.items ?? [])
			.map((ticket) => ({ original: ticket, projected: this.ticket(ticket) }))
			.filter(({ original, projected }) => original !== projected);
		if (!changes.length) return collection;
		const counts = { ...collection.counts.counts };
		const included = (ticket: TicketSummary) =>
			query.status
				? ticket.status === query.status
				: query.includeClosed || ticket.status !== 'closed';
		for (const { original, projected } of changes) {
			if (original.status === projected.status) continue;
			if (included(original)) counts[original.status] = Math.max(0, counts[original.status] - 1);
			if (included(projected)) counts[projected.status]++;
		}
		const windows: TicketCollection['windows'] = {};
		for (const key of keys) {
			const window = collection.windows[key]!;
			let items = window.items
				.map(
					(ticket) => changes.find(({ original }) => original.id === ticket.id)?.projected ?? ticket,
				)
				.filter((ticket) => (key === 'list' ? included(ticket) : ticket.status === key));
			if (key !== 'list' && window.pageIndex === 0) {
				const incoming = changes
					.filter(
						({ original, projected }) =>
							original.status !== projected.status && projected.status === key,
					)
					.map(({ projected }) => projected)
					.filter((ticket) => !items.some((item) => item.id === ticket.id));
				if (incoming.length)
					items = [...items, ...incoming]
						.sort((a, b) => b.number - a.number)
						.slice(0, ticketWindowLimit(key));
			}
			windows[key] = { ...window, items };
		}
		return { counts: { ...collection.counts, counts }, windows };
	}
}
