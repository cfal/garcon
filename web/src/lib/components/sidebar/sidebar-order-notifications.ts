import type { SidebarOrderErrorOutcome } from '$lib/sidebar/display/sidebar-order-controller.svelte';
import * as m from '$lib/paraglide/messages.js';

export function sidebarOrderErrorMessage(outcome: SidebarOrderErrorOutcome): string {
	switch (outcome) {
		case 'blocked':
			return m.notifications_reorder_chats_busy();
		case 'rejected':
			return m.notifications_reorder_chats_failed();
		case 'unconfirmed':
			return m.notifications_reorder_chats_unconfirmed();
	}
}
