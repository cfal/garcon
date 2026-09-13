import type { TicketActivity, TicketPriority, TicketStatus } from '$shared/tickets';
import * as m from '$lib/paraglide/messages.js';
import { ticketHref } from '$lib/tickets/catalog/ticket-deep-link.js';

export function ticketStatusLabel(status: TicketStatus): string {
	return {
		open: m.tickets_open,
		'in-progress': m.tickets_in_progress,
		'in-review': m.tickets_in_review,
		closed: m.tickets_closed,
	}[status]();
}
export function ticketPriorityLabel(priority: TicketPriority): string {
	return [m.tickets_urgent, m.tickets_high, m.tickets_normal, m.tickets_low][priority]!();
}
export function ticketActivityLabel(action: TicketActivity['action']): string {
	return {
		created: m.tickets_actor_created,
		updated: m.tickets_actor_updated,
		claimed: m.tickets_actor_claimed,
		released: m.tickets_actor_released,
		closed: m.tickets_actor_closed,
		reopened: m.tickets_actor_reopened,
		'comment-added': m.tickets_actor_comment_added,
		'comment-edited': m.tickets_actor_comment_edited,
		'comment-removed': m.tickets_actor_comment_removed,
		linked: m.tickets_actor_linked,
		unlinked: m.tickets_actor_unlinked,
	}[action]();
}
export interface TicketChatSummary {
	readonly id: string;
	readonly title: string | null;
}

export function isTicketProjectPath(project: string): boolean {
	return /^(?:[/\\]|[a-zA-Z]:[/\\])/.test(project);
}

export function ticketDeepLink(ticketId: string): string {
	return new URL(ticketHref(ticketId), window.location.origin).href;
}
