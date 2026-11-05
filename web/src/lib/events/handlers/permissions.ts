import type { LoadingStatusEntry } from '$lib/chat/conversation/conversation-lifecycle-state.svelte.js';
import type { ConversationUiPort } from '$lib/chat/conversation/conversation-ui-state.svelte.js';
import * as m from '$lib/paraglide/messages.js';

export function syncPermissionWaitingStatus(
	chatId: string,
	ui: Pick<ConversationUiPort, 'pendingPermissionsFor'>,
	lifecycle: {
		pushLoadingStatus(chatId: string, entry: LoadingStatusEntry): void;
		popLoadingStatus(chatId: string, id: string): void;
	},
): void {
	lifecycle.popLoadingStatus(chatId, 'WAITING_FOR_PERMISSION');
	if (ui.pendingPermissionsFor(chatId).some(request => request.control)) {
		lifecycle.pushLoadingStatus(chatId, { id: 'WAITING_FOR_PERMISSION', text: m.chat_loading_waiting_for_permission(), tokens: 0, can_interrupt: true });
	}
}
