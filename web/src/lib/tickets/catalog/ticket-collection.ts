import {
	TICKET_STATUSES,
	type TicketCounts,
	type TicketListQuery,
	type TicketPage,
	type TicketStatus,
	type TicketSummary,
} from '$shared/tickets';
import type { TicketsApi } from '$lib/api/tickets.js';
import { ApiError } from '$lib/api/client.js';

export type TicketLayout = 'list' | 'board';
export type TicketWindowKey = 'list' | TicketStatus;
export interface TicketWindow {
	readonly items: readonly TicketSummary[];
	readonly nextBeforeNumber: number | null;
	readonly starts: readonly (number | undefined)[];
	readonly pageIndex: number;
}
export interface TicketCollection {
	readonly counts: TicketCounts;
	readonly windows: Partial<Record<TicketWindowKey, TicketWindow>>;
}

export function ticketLanes(query: TicketListQuery): readonly TicketStatus[] {
	return query.status
		? [query.status]
		: query.includeClosed
			? TICKET_STATUSES
			: TICKET_STATUSES.filter((status) => status !== 'closed');
}

export function requireTicketVersion(
	value: { storeId: string; collectionRevision: number },
	storeId: string,
	revision?: number,
): void {
	if (value.storeId !== storeId)
		throw new ApiError(409, 'Ticket store changed', 'TICKET_STORE_CHANGED');
	if (revision !== undefined && value.collectionRevision !== revision) {
		throw new ApiError(
			409,
			'Tickets changed while loading',
			'TICKET_COLLECTION_CHANGED',
			undefined,
			true,
		);
	}
}

export function ticketWindowLimit(key: TicketWindowKey): number {
	return key === 'list' ? 500 : 100;
}

export function ticketWindowQuery(
	query: TicketListQuery,
	key: TicketWindowKey,
	revision: number,
	limit: number,
	beforeNumber?: number,
): TicketListQuery {
	return {
		...query,
		...(key === 'list' ? {} : { status: key }),
		limit,
		expectedCollectionRevision: revision,
		...(beforeNumber === undefined ? {} : { beforeNumber }),
	};
}

// Previous windows belong to the same query and layout; their owner clears them when either changes.
export async function loadTicketCollection(
	api: Pick<TicketsApi, 'counts' | 'list'>,
	query: TicketListQuery,
	layout: TicketLayout,
	storeId: string,
	anchors: Partial<Record<TicketWindowKey, number>>,
	signal: AbortSignal,
	previous: TicketCollection | null = null,
): Promise<TicketCollection> {
	const counts = await api.counts(query, signal);
	requireTicketVersion(counts, storeId);
	const keys: readonly TicketWindowKey[] = layout === 'list' ? ['list'] : ticketLanes(query);
	if (
		previous?.counts.storeId === storeId &&
		previous.counts.collectionRevision === counts.collectionRevision &&
		keys.every((key) => previous.windows[key])
	)
		return previous;
	const entries = await Promise.all(
		keys.map(async (key) => {
			const prior = previous?.windows[key];
			const sameRevision = previous?.counts.collectionRevision === counts.collectionRevision;
			const anchor = prior?.pageIndex ? (anchors[key] ?? prior.items[0]?.number) : undefined;
			const beforeNumber = sameRevision
				? prior?.starts[prior.pageIndex]
				: anchor === undefined
					? undefined
					: anchor + 1;
			const size = Math.min(ticketWindowLimit(key), Math.max(50, prior?.items.length ?? 0));
			const page = await api.list(
				ticketWindowQuery(query, key, counts.collectionRevision, Math.min(100, size), beforeNumber),
				signal,
			);
			requireTicketVersion(page, storeId, counts.collectionRevision);
			let window: TicketWindow = {
				items: page.items,
				nextBeforeNumber: page.nextBeforeNumber,
				starts: sameRevision && prior ? prior.starts : [beforeNumber],
				pageIndex: sameRevision && prior ? prior.pageIndex : 0,
			};
			// Initial byte-packed pages stay incremental; refresh retains the already loaded bounded window.
			while (prior && window.items.length < size && window.nextBeforeNumber !== null) {
				const next = await api.list(
					ticketWindowQuery(
						query,
						key,
						counts.collectionRevision,
						Math.min(100, size - window.items.length),
						window.nextBeforeNumber,
					),
					signal,
				);
				requireTicketVersion(next, storeId, counts.collectionRevision);
				if (!next.items.length) throw new Error('Empty ticket continuation');
				window = appendTicketPage(window, next, key);
			}
			return [key, window] as const;
		}),
	);
	return { counts, windows: Object.fromEntries(entries) };
}

export function appendTicketPage(
	window: TicketWindow,
	page: TicketPage,
	key: TicketWindowKey,
): TicketWindow {
	const items = [...window.items, ...page.items];
	if (
		items.length > ticketWindowLimit(key) ||
		new Set(items.map((item) => item.id)).size !== items.length
	) {
		throw new Error('Invalid ticket window continuation');
	}
	return { ...window, items, nextBeforeNumber: page.nextBeforeNumber };
}
