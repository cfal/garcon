import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { tick } from 'svelte';
import { ModelCatalogStore } from '$lib/agents/model-catalog-store.svelte';
import { RemoteSettingsStore } from '$lib/stores/remote-settings.svelte';
import { makeRemoteSettingsSnapshot } from '$lib/stores/__tests__/remote-settings-snapshot-fixture';
import type { TicketsController } from '$lib/tickets/catalog/tickets-controller.svelte';
import { TicketDispatchController } from '$lib/tickets/dispatch/ticket-dispatch-controller.svelte';
import TicketsTestHost from './TicketsTestHost.svelte';
import { syntheticTicket, ticketTestHarness } from './ticket-test-harness';

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
	const remoteSettings = new RemoteSettingsStore();
	remoteSettings.applySnapshot(makeRemoteSettingsSnapshot());
	const ticketDispatch = new TicketDispatchController({
		remoteSettings,
		modelCatalog: new ModelCatalogStore(),
		sessions: { byId: {} },
		notifications: { error: () => undefined },
		startChat: () => undefined,
	});
	const dispatch = vi.spyOn(ticketDispatch, 'dispatch').mockResolvedValue(true);
	render(TicketsTestHost, { controller: fixture.controller, ticketDispatch });
	await tick();
	return { ...fixture, dispatch };
}

describe('ticket dispatch entry points', () => {
	it('creates the ticket and then dispatches the confirmed ticket', async () => {
		const { controller, api, dispatch } = await mount();
		await fireEvent.click(screen.getByRole('button', { name: 'New ticket' }));
		const dialog = within(await screen.findByRole('dialog'));
		await fireEvent.input(dialog.getByLabelText('Title'), { target: { value: 'Synthetic dispatch' } });
		await fireEvent.input(dialog.getByLabelText('Project'), { target: { value: '/synthetic/repo' } });

		const action = dialog.getByRole('button', { name: 'Create & dispatch' });
		expect(action.closest('[role="group"]')?.getAttribute('aria-label')).toBe('Dispatch to an agent');
		await fireEvent.click(action);

		await waitFor(() => expect(dispatch).toHaveBeenCalledOnce());
		expect(api.mutate.mock.calls.at(-1)?.[0].payload).toMatchObject({
			action: 'create',
			input: { title: 'Synthetic dispatch', project: '/synthetic/repo' },
		});
		expect(dispatch).toHaveBeenCalledWith(
			expect.objectContaining({ title: 'Synthetic dispatch', project: '/synthetic/repo', revision: 1 }),
			controller,
		);
	});

	it('creates without dispatching from the plain create button', async () => {
		const { dispatch } = await mount();
		await fireEvent.click(screen.getByRole('button', { name: 'New ticket' }));
		const dialog = within(await screen.findByRole('dialog'));
		await fireEvent.input(dialog.getByLabelText('Title'), { target: { value: 'Plain create' } });
		await fireEvent.input(dialog.getByLabelText('Project'), { target: { value: '/synthetic/repo' } });

		await fireEvent.click(dialog.getByRole('button', { name: 'Create ticket' }));

		await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
		expect(dispatch).not.toHaveBeenCalled();
	});

	it('keeps Create & dispatch behind the same submit gate as Create ticket', async () => {
		await mount();
		await fireEvent.click(screen.getByRole('button', { name: 'New ticket' }));
		const dialog = within(await screen.findByRole('dialog'));

		expect(dialog.getByRole('button', { name: 'Create ticket' }).hasAttribute('disabled')).toBe(true);
		expect(dialog.getByRole('button', { name: 'Create & dispatch' }).hasAttribute('disabled')).toBe(true);
	});

	it('dispatches an existing ticket from its detail view', async () => {
		const { controller, dispatch } = await mount();
		await fireEvent.click(screen.getByRole('button', { name: 'Open G-1' }));
		await controller.refresh();
		const detail = within(screen.getByRole('region', { name: 'Ticket details' }));

		await fireEvent.click(detail.getByRole('button', { name: 'Dispatch' }));

		expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ id: 'G-1' }), controller);
	});
});
