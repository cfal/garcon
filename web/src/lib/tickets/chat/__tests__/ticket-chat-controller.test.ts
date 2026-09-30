import { describe, expect, it, vi } from 'vitest';
import { AppShellStore } from '$lib/stores/app-shell.svelte';
import { makeRemoteSettingsSnapshot } from '$lib/stores/__tests__/remote-settings-snapshot-fixture';
import {
	TicketChatController,
	type TicketChatControllerDeps,
} from '../ticket-chat-controller.svelte';

const ticket = {
	id: 'G-1',
	title: 'Synthetic title',
	project: 'A label, not a folder',
	description: 'Synthetic description',
};

function fixture() {
	const appShell = new AppShellStore();
	const snapshot = makeRemoteSettingsSnapshot({
		ui: {
			ticketChat: {
				customPrompt: '{{ticket_id}}: {{ticket_title}}\n{{ticket_project}}\n{{ticket_description}}',
			},
		},
	});
	const remoteSettings = {
		ensureLoaded: vi.fn(async () => snapshot),
	} satisfies TicketChatControllerDeps['remoteSettings'];
	const notifications = { error: vi.fn() };
	const controller = new TicketChatController({ appShell, remoteSettings, notifications });
	return { appShell, snapshot, remoteSettings, notifications, controller };
}

describe('TicketChatController', () => {
	it('opens New Chat with only editable text, not execution settings or a ticket mutation', async () => {
		const { controller, appShell, snapshot } = fixture();
		await controller.open(ticket);
		expect(appShell.newChatDialogOpen).toBe(true);
		expect(appShell.newChatDialogSeed).toEqual({
			prefill: 'G-1: Synthetic title\nA label, not a folder\nSynthetic description',
		});
		snapshot.ui.ticketChat = { customPrompt: 'Changed {{ticket_id}}' };
		expect(appShell.newChatDialogSeed?.prefill).toContain('Synthetic description');
	});

	it('ignores repeated clicks and snapshots ticket content while loading settings', async () => {
		const { controller, appShell, remoteSettings, snapshot } = fixture();
		const pending = Promise.withResolvers<typeof snapshot>();
		remoteSettings.ensureLoaded.mockReturnValueOnce(pending.promise);
		const subject = { ...ticket };
		const opening = controller.open(subject);
		subject.title = 'Later edit';
		await controller.open(ticket);
		expect(remoteSettings.ensureLoaded).toHaveBeenCalledOnce();
		pending.resolve(snapshot);
		await opening;
		expect(appShell.newChatDialogSeed?.prefill).toContain('Synthetic title');
		expect(controller.opening).toBe(false);
	});

	it('does not overwrite an existing New Chat draft', async () => {
		const { controller, appShell, remoteSettings } = fixture();
		appShell.openNewChatDialog({ prefill: 'Existing draft' });
		await controller.open(ticket);
		expect(remoteSettings.ensureLoaded).not.toHaveBeenCalled();
		expect(appShell.newChatDialogSeed).toEqual({ prefill: 'Existing draft' });
	});

	it('does not reopen after another New Chat request supersedes a pending open', async () => {
		const { controller, appShell, remoteSettings, snapshot } = fixture();
		const pending = Promise.withResolvers<typeof snapshot>();
		remoteSettings.ensureLoaded.mockReturnValueOnce(pending.promise);
		const opening = controller.open(ticket);
		appShell.openNewChatDialog();
		appShell.closeNewChatDialog();
		pending.resolve(snapshot);
		await opening;
		expect(appShell.newChatDialogOpen).toBe(false);
	});

	it('reports settings failures without opening a chat', async () => {
		const { controller, appShell, remoteSettings, notifications } = fixture();
		remoteSettings.ensureLoaded.mockRejectedValueOnce(new Error('Synthetic failure'));
		await controller.open(ticket);
		expect(notifications.error).toHaveBeenCalledWith('Synthetic failure');
		expect(appShell.newChatDialogOpen).toBe(false);
		expect(controller.opening).toBe(false);
	});

	it('reports oversized expansion without opening a chat', async () => {
		const { controller, snapshot, appShell, notifications } = fixture();
		snapshot.ui.ticketChat = {
			customPrompt: '{{ticket_id}}' + '{{ticket_description}}'.repeat(1000),
		};
		await controller.open({ ...ticket, description: 'x'.repeat(1000) });
		expect(appShell.newChatDialogOpen).toBe(false);
		expect(notifications.error).toHaveBeenCalledWith(expect.stringContaining('exceeds'));
	});
});
