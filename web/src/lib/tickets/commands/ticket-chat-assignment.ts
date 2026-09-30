import type { TicketMutationPayload } from '$shared/ticket-commands';
import type { Ticket } from '$shared/tickets';

/** Assigns the ticket to a chat and moves an Open ticket to In progress, as a claim would. */
export function ticketChatAssignment(
	ticket: Pick<Ticket, 'id' | 'revision' | 'status'>,
	chatId: string,
): TicketMutationPayload {
	return {
		action: 'update',
		ticketId: ticket.id,
		expectedRevision: ticket.revision,
		patch: {
			assignee: { kind: 'chat', chatId },
			...(ticket.status === 'open' ? { status: 'in-progress' as const } : {}),
		},
	};
}
