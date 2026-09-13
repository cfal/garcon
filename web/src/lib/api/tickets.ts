import {
	parseHttpTicketMutationRequest,
	type HttpTicketMutationRequest,
} from '$shared/ticket-commands';
import { ticketSearchParams } from '$shared/ticket-query';
import { parseTicket, parseTicketComment, parseTicketWriteResult } from '$shared/ticket-records';
import {
	parseTicketBootstrap,
	parseTicketCommentsPage,
	parseTicketCounts,
	parseTicketDetail,
	parseTicketFacets,
	parseTicketHistoryPage,
	parseTicketPage,
	parseTicketProjectDefault,
} from '$shared/ticket-responses';
import { ticketBytes } from '$shared/ticket-validation';
import {
	TICKET_LIMITS,
	type Ticket,
	type TicketActivity,
	type TicketBootstrap,
	type TicketComment,
	type TicketCommentsQuery,
	type TicketCommentView,
	type TicketCounts,
	type TicketDetail,
	type TicketFacets,
	type TicketHistoryQuery,
	type TicketListQuery,
	type TicketPage,
	type TicketProjectDefault,
	type TicketReadQuery,
	type TicketSequencePage,
	type TicketWriteResult,
} from '$shared/tickets';
import { ApiError, apiGet, apiPost } from './client.js';

export interface TicketsApi {
	bootstrap(signal?: AbortSignal): Promise<TicketBootstrap>;
	list(query: TicketListQuery, signal?: AbortSignal): Promise<TicketPage>;
	counts(query: TicketListQuery, signal?: AbortSignal): Promise<TicketCounts>;
	read(query: TicketReadQuery, signal?: AbortSignal): Promise<TicketDetail>;
	comments(
		query: TicketCommentsQuery,
		signal?: AbortSignal,
	): Promise<TicketSequencePage<TicketCommentView>>;
	history(
		query: TicketHistoryQuery,
		signal?: AbortSignal,
	): Promise<TicketSequencePage<TicketActivity>>;
	facets(field: 'project' | 'label', prefix: string, signal?: AbortSignal): Promise<TicketFacets>;
	projectDefault(directory: string, signal?: AbortSignal): Promise<TicketProjectDefault>;
	mutate(request: HttpTicketMutationRequest, signal?: AbortSignal): Promise<TicketWriteResult>;
}

export interface TicketConflict {
	readonly ticket?: Ticket;
	readonly comment?: TicketComment;
}

export function ticketConflict(error: unknown): TicketConflict | null {
	if (
		!(error instanceof ApiError) ||
		error.status !== 409 ||
		!error.payload ||
		typeof error.payload !== 'object'
	)
		return null;
	const payload = error.payload as Record<string, unknown>;
	try {
		return {
			...(payload.currentTicket ? { ticket: parseTicket(payload.currentTicket) } : {}),
			...(payload.currentComment ? { comment: parseTicketComment(payload.currentComment) } : {}),
		};
	} catch {
		return null;
	}
}

const route = '/api/v1/tickets';
const get = (suffix: string, signal?: AbortSignal) =>
	apiGet<unknown>(`${route}${suffix}`, { signal, cache: 'no-store' });

export const ticketsApi: TicketsApi = {
	async bootstrap(signal) {
		return parseTicketBootstrap(await get('/bootstrap', signal));
	},
	async list(query, signal) {
		return parseTicketPage(await get(`?${ticketSearchParams(query)}`, signal));
	},
	async counts(query, signal) {
		return parseTicketCounts(await get(`/counts?${ticketSearchParams(query)}`, signal));
	},
	async read(query, signal) {
		const result = parseTicketDetail(await get(`/detail?${ticketSearchParams(query)}`, signal));
		if (result.ticket.id !== query.ticketId)
			throw new Error('Ticket response does not match the selected ticket');
		return result;
	},
	async comments(query, signal) {
		const result = parseTicketCommentsPage(
			await get(`/comments?${ticketSearchParams(query)}`, signal),
		);
		if (result.items.some((item) => item.ticketId !== query.ticketId))
			throw new Error('Comment response belongs to another ticket');
		return result;
	},
	async history(query, signal) {
		const result = parseTicketHistoryPage(await get(`/history?${ticketSearchParams(query)}`, signal));
		if (result.items.some((item) => item.ticketId !== query.ticketId))
			throw new Error('Activity response belongs to another ticket');
		return result;
	},
	async facets(field, prefix, signal) {
		return parseTicketFacets(await get(`/facets?${new URLSearchParams({ field, prefix })}`, signal));
	},
	async projectDefault(directory, signal) {
		return parseTicketProjectDefault(
			await apiPost<unknown>(`${route}/project-default`, { directory }, { signal }),
		);
	},
	async mutate(input, signal) {
		const request = parseHttpTicketMutationRequest(input);
		if (ticketBytes(JSON.stringify(request)) > TICKET_LIMITS.requestBytes) {
			throw new ApiError(
				413,
				'Encoded ticket request exceeds 64 KiB. Reduce the submitted body.',
				'TICKET_REQUEST_TOO_LARGE',
			);
		}
		const result = parseTicketWriteResult(
			await apiPost<unknown>(`${route}/mutate`, request, { signal }),
		);
		if (
			result.storeId !== request.expectedStoreId ||
			(request.payload.action !== 'create' && result.ticket.id !== request.payload.ticketId)
		) {
			throw new Error('Ticket mutation response does not match the submitted request');
		}
		return result;
	},
};
