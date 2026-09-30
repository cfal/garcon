import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { tick } from 'svelte';
import { ApiError } from '$lib/api/client';
import type { TicketsController } from '$lib/tickets/catalog/tickets-controller.svelte';
import { AppShellStore } from '$lib/stores/app-shell.svelte';
import type { TicketWriteResult } from '$shared/tickets';
import TicketsTestHost from './TicketsTestHost.svelte';
import { syntheticTicket, ticketTestHarness, TICKET_STORE } from './ticket-test-harness';

const controllers: TicketsController[] = [];
afterEach(() => {
	cleanup();
	controllers.splice(0).forEach((controller) => controller.dispose());
});

async function mount() {
	const fixture = ticketTestHarness([syntheticTicket()]);
	controllers.push(fixture.controller);
	fixture.controller.setPresentationVisible(true);
	await fixture.controller.refresh();
	const appShell = new AppShellStore();
	render(TicketsTestHost, { controller: fixture.controller, appShell });
	await tick();
	return { ...fixture, appShell };
}

async function fillCreate() {
	await fireEvent.click(screen.getByRole('button', { name: 'New ticket' }));
	const dialog = within(await screen.findByRole('dialog'));
	await fireEvent.input(dialog.getByLabelText('Title'), {
		target: { value: 'Synthetic new ticket' },
	});
	await fireEvent.input(dialog.getByLabelText('Project'), { target: { value: 'Project label' } });
	return dialog;
}

describe('new chat from ticket', () => {
	it('opens the normal New Chat dialog with ticket text, without assigning or updating the ticket', async () => {
		const { controller, api, appShell } = await mount();
		await fireEvent.click(screen.getByRole('button', { name: 'Open G-1' }));
		await controller.refresh();
		await fireEvent.click(screen.getByRole('button', { name: 'New chat from ticket' }));
		await waitFor(() => expect(appShell.newChatDialogOpen).toBe(true));
		expect(Object.keys(appShell.newChatDialogSeed!)).toEqual(['prefill']);
		expect(appShell.newChatDialogSeed?.prefill).toContain('Ticket G-1: Synthetic ticket 1');
		expect(appShell.newChatDialogSeed?.prefill).toContain('Project label: Release');
		expect(api.mutate).not.toHaveBeenCalled();
		appShell.closeNewChatDialog();
		expect(api.mutate).not.toHaveBeenCalled();
	});

	it('confirms creation before opening New Chat and leaves the ticket open and unassigned', async () => {
		const { api, appShell } = await mount();
		const dialog = await fillCreate();
		await fireEvent.click(dialog.getByRole('button', { name: 'Create & open chat' }));
		await waitFor(() => expect(appShell.newChatDialogOpen).toBe(true));
		expect(appShell.newChatDialogSeed?.prefill).toContain('Synthetic new ticket');
		expect(api.mutate).toHaveBeenCalledOnce();
		const result = await api.mutate.mock.results[0]!.value;
		expect(result.ticket).toMatchObject({
			status: 'open',
			assignee: null,
			project: 'Project label',
		});
	});

	it('does not open New Chat from the plain create button', async () => {
		const { appShell } = await mount();
		const dialog = await fillCreate();
		await fireEvent.click(dialog.getByRole('button', { name: 'Create ticket' }));
		await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
		expect(appShell.newChatDialogOpen).toBe(false);
	});

	it('uses the same submit gate for both create actions', async () => {
		await mount();
		await fireEvent.click(screen.getByRole('button', { name: 'New ticket' }));
		const dialog = within(await screen.findByRole('dialog'));
		expect(dialog.getByRole('button', { name: 'Create ticket' }).hasAttribute('disabled')).toBe(
			true,
		);
		expect(
			dialog.getByRole('button', { name: 'Create & open chat' }).hasAttribute('disabled'),
		).toBe(true);
	});

	it('continues once after an explicit retry confirms an uncertain create', async () => {
		const { api, appShell } = await mount();
		api.mutate.mockRejectedValueOnce(new Error('Lost response'));
		const dialog = await fillCreate();
		await fireEvent.click(dialog.getByRole('button', { name: 'Create & open chat' }));
		await dialog.findByRole('button', { name: 'Retry same request' });
		expect(appShell.newChatDialogOpen).toBe(false);
		const request = api.mutate.mock.calls[0]![0];
		const open = vi.spyOn(appShell, 'openNewChatDialog');
		await fireEvent.click(dialog.getByRole('button', { name: 'Retry same request' }));
		await waitFor(() => expect(open).toHaveBeenCalledOnce());
		expect(api.mutate.mock.calls[1]![0]).toEqual(request);
	});

	it.each([
		['Create ticket', false],
		['Create & open chat', true],
	] as const)(
		'honors %s after a retry definitively rejects the previous create',
		async (action, opensChat) => {
			const { api, appShell } = await mount();
			api.mutate
				.mockRejectedValueOnce(new Error('Lost response'))
				.mockRejectedValueOnce(new ApiError(404, 'Ticket not found.', 'TICKET_NOT_FOUND'));
			const dialog = await fillCreate();
			await fireEvent.click(dialog.getByRole('button', { name: 'Create & open chat' }));
			await dialog.findByRole('button', { name: 'Retry same request' });
			const request = api.mutate.mock.calls[0]![0];
			await fireEvent.click(dialog.getByRole('button', { name: 'Retry same request' }));
			await waitFor(() =>
				expect(dialog.queryByRole('button', { name: 'Retry same request' })).toBeNull(),
			);
			expect(api.mutate.mock.calls[1]![0]).toEqual(request);
			expect(appShell.newChatDialogOpen).toBe(false);

			await fireEvent.click(dialog.getByRole('button', { name: action }));
			await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
			expect(api.mutate).toHaveBeenCalledTimes(3);
			expect(api.mutate.mock.calls[2]![0].requestId).not.toBe(request.requestId);
			expect(api.mutate.mock.calls[2]![0].payload).toEqual(request.payload);
			expect(appShell.newChatDialogOpen).toBe(opensChat);
		},
	);

	it('does not retain create-and-open intent after discarding a failed request', async () => {
		const { api, appShell } = await mount();
		api.mutate.mockRejectedValueOnce(new Error('Lost response'));
		const dialog = await fillCreate();
		await fireEvent.click(dialog.getByRole('button', { name: 'Create & open chat' }));
		await dialog.findByRole('button', { name: 'Retry same request' });
		await fireEvent.click(dialog.getByRole('button', { name: 'Discard draft' }));
		await fireEvent.input(dialog.getByLabelText('Title'), {
			target: { value: 'Replacement ticket' },
		});
		await fireEvent.input(dialog.getByLabelText('Project'), { target: { value: 'Project label' } });
		await fireEvent.click(dialog.getByRole('button', { name: 'Create ticket' }));
		await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
		expect(appShell.newChatDialogOpen).toBe(false);
	});

	it('does not open after the Tickets controller is disposed during creation', async () => {
		const { controller, api, appShell } = await mount();
		const pending = Promise.withResolvers<TicketWriteResult>();
		api.mutate.mockReturnValueOnce(pending.promise);
		const dialog = await fillCreate();
		await fireEvent.click(dialog.getByRole('button', { name: 'Create & open chat' }));
		cleanup();
		controller.dispose();
		pending.resolve({
			success: true,
			ticket: syntheticTicket(2),
			storeId: TICKET_STORE,
			collectionRevision: 2,
		});
		await pending.promise;
		await tick();
		expect(appShell.newChatDialogOpen).toBe(false);
	});
});
