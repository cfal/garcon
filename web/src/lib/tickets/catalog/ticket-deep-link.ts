import { ticketId } from '$shared/ticket-validation';

export function selectedTicketFromUrl(url: URL): string | null {
	const values = url.searchParams.getAll('ticket');
	if (values.length !== 1) return null;
	try {
		return ticketId(values[0]);
	} catch {
		return null;
	}
}
