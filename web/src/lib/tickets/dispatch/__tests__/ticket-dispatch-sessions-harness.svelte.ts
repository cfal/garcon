import type { ChatStatus } from '$lib/types/chat-session.js';
import type { TicketDispatchControllerDeps } from '../ticket-dispatch-controller.svelte.js';

/** Publishes chat records reactively, as the sessions store does when a draft starts. */
export class DispatchSessionsHarness implements Pick<TicketDispatchControllerDeps['sessions'], 'byId'> {
	byId = $state<Record<string, { status: ChatStatus }>>({});

	setStatus(chatId: string, status: ChatStatus): void {
		this.byId = { ...this.byId, [chatId]: { status } };
	}

	remove(chatId: string): void {
		const next = { ...this.byId };
		delete next[chatId];
		this.byId = next;
	}
}
