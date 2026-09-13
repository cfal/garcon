import type { TicketSource } from '$shared/tickets';
import {
	parseTicketSourceResolution,
	type TicketSourceResolution,
} from '$shared/ticket-source-navigation';
import { apiGet } from './client.js';

export async function resolveTicketSource(
	source: TicketSource,
	signal: AbortSignal,
): Promise<TicketSourceResolution> {
	const query = new URLSearchParams({
		chatId: source.chatId,
		transcriptViewId: source.transcriptViewId,
		ordinal: String(source.ordinal),
	});
	const result = parseTicketSourceResolution(
		await apiGet<unknown>(`/api/v1/chats/ticket-source?${query}`, { signal, cache: 'no-store' }),
	);
	const chatId = result.kind === 'found' ? result.target.chatId : result.chatId;
	if (
		chatId !== source.chatId ||
		(result.kind === 'found' && result.target.transcriptViewId !== source.transcriptViewId)
	) {
		throw new Error('Ticket source response does not match its request');
	}
	return result;
}
