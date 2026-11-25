import type { Ticket, TicketBootstrap, TicketLink, TicketLinkKind } from '$shared/tickets';
import type { TicketMutationPayload } from '$shared/ticket-commands';
import type { TicketsApi } from '$lib/api/tickets.js';
import { requireTicketVersion } from '../catalog/ticket-collection.js';

type TicketRevision = Pick<Ticket, 'id' | 'revision'>;

interface RelationshipDeps {
	api: Pick<TicketsApi, 'read'>;
	current: () => TicketBootstrap | null;
	mutate: (ticket: TicketRevision, payload: TicketMutationPayload) => Promise<boolean>;
	onError: (error: unknown) => void;
}

export class TicketRelationships {
	#reads = new AbortController();

	constructor(private readonly deps: RelationshipDeps) {}

	cancelReads(): void {
		this.#reads.abort();
		this.#reads = new AbortController();
	}

	link(
		source: TicketRevision,
		targetId: string,
		kind: TicketLinkKind,
		action: 'link' | 'unlink',
	): Promise<void> {
		return this.#change(source, targetId, kind, action);
	}

	unlink(link: TicketLink): Promise<void> {
		return this.#change(link.sourceId, link.targetId, link.kind, 'unlink');
	}

	async #change(
		sourceOrId: TicketRevision | string,
		targetId: string,
		kind: TicketLinkKind,
		action: 'link' | 'unlink',
	): Promise<void> {
		const partition = this.deps.current();
		if (!partition) return;
		const signal = this.#reads.signal;
		const isCurrent = () => !signal.aborted && this.deps.current() === partition;
		try {
			const source =
				typeof sourceOrId === 'string'
					? await this.#read(sourceOrId, partition, signal)
					: sourceOrId;
			if (!isCurrent()) return;
			const target = await this.#read(targetId, partition, signal);
			if (!isCurrent()) return;
			await this.deps.mutate(source, {
				action,
				ticketId: source.id,
				expectedRevision: source.revision,
				targetId,
				targetRevision: target.revision,
				kind,
			});
		} catch (error) {
			if (isCurrent()) this.deps.onError(error);
		}
	}

	async #read(
		ticketId: string,
		partition: TicketBootstrap,
		signal: AbortSignal,
	): Promise<TicketRevision> {
		const result = await this.deps.api.read(
			{ ticketId, includeDescription: false, commentLimit: 0 },
			signal,
		);
		requireTicketVersion(result, partition.storeId);
		return result.ticket;
	}
}
