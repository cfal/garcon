import type { AppShellStore } from '$lib/stores/app-shell.svelte.js';
import type { RemoteSettingsStore } from '$lib/stores/remote-settings.svelte.js';
import { renderTicketChatPrompt, type TicketChatSubject } from '$shared/ticket-chat';
import * as m from '$lib/paraglide/messages.js';

export interface TicketChatControllerDeps {
	readonly appShell: Pick<
		AppShellStore,
		'newChatDialogOpen' | 'openNewChatDialog' | 'onNewChatDialogSeed'
	>;
	readonly remoteSettings: Pick<RemoteSettingsStore, 'ensureLoaded'>;
	readonly notifications: { error(message: string): unknown };
}

export class TicketChatController {
	opening = $state(false);

	constructor(private readonly deps: TicketChatControllerDeps) {}

	async open(ticket: TicketChatSubject): Promise<void> {
		if (this.opening || this.deps.appShell.newChatDialogOpen) return;
		const subject = { ...ticket };
		this.opening = true;
		let superseded = false;
		const unsubscribe = this.deps.appShell.onNewChatDialogSeed(() => {
			superseded = true;
		});
		try {
			const snapshot = await this.deps.remoteSettings.ensureLoaded();
			if (superseded) return;
			const prefill = renderTicketChatPrompt(snapshot.ui.ticketChat?.customPrompt, subject);
			this.deps.appShell.openNewChatDialog({ prefill });
		} catch (error) {
			if (!superseded)
				this.deps.notifications.error(
					error instanceof Error ? error.message : m.tickets_chat_settings_unavailable(),
				);
		} finally {
			unsubscribe();
			this.opening = false;
		}
	}
}
