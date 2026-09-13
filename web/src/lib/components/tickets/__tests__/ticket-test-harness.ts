import { vi } from 'vitest';
import type { TicketsApi } from '$lib/api/tickets';
import type { Ticket, TicketCommentView, TicketListQuery } from '$shared/tickets';
import { TicketsController } from '$lib/tickets/catalog/tickets-controller.svelte';
import { TicketsInvalidationHub } from '$lib/tickets/catalog/tickets-invalidation-hub';
import { createTicketRecovery } from '$lib/tickets/drafts/ticket-draft-recovery';

export const TICKET_STORE = '11111111-1111-4111-8111-111111111111';
export const syntheticTicket = (number = 1): Ticket => ({
	id: `G-${number}`,
	number,
	revision: 1,
	title: `Synthetic ticket ${number}`,
	description: 'Synthetic description',
	project: 'Release',
	status: 'open',
	resolution: null,
	priority: 2,
	labels: [],
	assignee: null,
	parentId: null,
	createdAt: '2026-01-01T00:00:00.000Z',
	updatedAt: '2026-01-01T00:00:00.000Z',
	createdBy: { kind: 'user', username: 'local', principalMode: 'local', declaredChatId: null },
});

export function ticketTestHarness(initial = [syntheticTicket()]) {
	let items = [...initial];
	let revision = 1;
	let comments: TicketCommentView[] = [];
	const version = () => ({ storeId: TICKET_STORE, collectionRevision: revision });
	const filter = (query: TicketListQuery) =>
		items.filter(
			(ticket) =>
				(query.status
					? ticket.status === query.status
					: query.includeClosed || ticket.status !== 'closed') &&
				(!query.project || ticket.project === query.project),
		);
	const api = {
		bootstrap: vi.fn<TicketsApi['bootstrap']>(async () => ({
			...version(),
			viewerKey: 'synthetic-viewer',
		})),
		counts: vi.fn<TicketsApi['counts']>(async (query) => {
			const counts = { open: 0, 'in-progress': 0, 'in-review': 0, closed: 0 };
			for (const ticket of filter(query)) counts[ticket.status]++;
			return { ...version(), counts };
		}),
		list: vi.fn<TicketsApi['list']>(async (query) => ({
			...version(),
			items: filter(query).map(({ description: _, ...ticket }) => ({
				...ticket,
				blockedByCount: 0,
				commentCount: comments.filter((entry) => entry.ticketId === ticket.id && !entry.deletedAt)
					.length,
			})),
			nextBeforeNumber: null,
		})),
		read: vi.fn<TicketsApi['read']>(async (query) => ({
			...version(),
			ticket: items.find((ticket) => ticket.id === query.ticketId)!,
			links: [],
			comments: {
				...version(),
				items: comments.filter((entry) => entry.ticketId === query.ticketId),
				nextBeforeSequence: null,
			},
		})),
		comments: vi.fn<TicketsApi['comments']>(async () => ({
			...version(),
			items: comments,
			nextBeforeSequence: null,
		})),
		history: vi.fn<TicketsApi['history']>(async () => ({
			...version(),
			items: [],
			nextBeforeSequence: null,
		})),
		facets: vi.fn<TicketsApi['facets']>(async (field) => ({
			...version(),
			values: field === 'project' ? ['Release'] : ['bug', 'frontend'],
		})),
		projectDefault: vi.fn<TicketsApi['projectDefault']>(async () => ({
			project: '/repository',
			kind: 'repository',
		})),
		mutate: vi.fn<TicketsApi['mutate']>(async ({ payload }) => {
			revision++;
			let ticket: Ticket;
			if (payload.action === 'create') {
				ticket = { ...syntheticTicket(items.length + 1), ...payload.input };
				items.push(ticket);
			} else {
				ticket = items.find((entry) => entry.id === payload.ticketId)!;
				if (payload.action === 'update')
					ticket = { ...ticket, ...payload.patch, revision: ticket.revision + 1 };
				if (payload.action === 'close')
					ticket = {
						...ticket,
						status: 'closed',
						resolution: payload.resolution ?? 'done',
						revision: ticket.revision + 1,
					};
				if (payload.action === 'comment')
					comments = [
						...comments,
						{
							id: crypto.randomUUID(),
							ticketId: ticket.id,
							sequence: comments.length + 1,
							revision: 1,
							body: payload.body,
							author: ticket.createdBy,
							createdAt: ticket.createdAt,
							updatedAt: ticket.createdAt,
							deletedAt: null,
							canEdit: true,
						},
					];
				items = items.map((entry) => (entry.id === ticket.id ? ticket : entry));
			}
			return { ...version(), success: true, ticket };
		}),
	} satisfies TicketsApi;
	const values = new Map<string, string>();
	const storage = {
		get length() {
			return values.size;
		},
		getItem: (key) => values.get(key) ?? null,
		setItem: (key, value) => {
			values.set(key, value);
		},
		removeItem: (key) => {
			values.delete(key);
		},
		key: (index) => [...values.keys()][index] ?? null,
		clear: () => values.clear(),
	} satisfies Storage;
	const invalidations = new TicketsInvalidationHub();
	const recovery = createTicketRecovery(() => storage);
	const controller = new TicketsController({
		api,
		invalidations,
		recovery,
		preferences: { read: () => ({ layout: 'list', query: {} }), write: () => {} },
	});
	return {
		controller,
		api,
		invalidations,
		recovery,
		storage,
		setItems(next: Ticket[]) {
			items = next;
			revision++;
		},
		setComments(next: TicketCommentView[]) {
			comments = next;
			revision++;
		},
	};
}
