import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import type { TicketsController } from '$lib/tickets/catalog/tickets-controller.svelte';
import TicketDraftFeedback from '../TicketDraftFeedback.svelte';
import TicketRecovery from '../TicketRecovery.svelte';
import { ticketTestHarness } from './ticket-test-harness';

const controllers: TicketsController[] = [];
afterEach(() => {
	cleanup();
	controllers.splice(0).forEach((controller) => controller.dispose());
});

async function draftFixture() {
	const fixture = ticketTestHarness();
	controllers.push(fixture.controller);
	fixture.controller.setPresentationVisible(true);
	await fixture.controller.refresh();
	const draft = fixture.controller.drafts.open('create', null)!;
	draft.setField('title', 'Synthetic unsaved title');
	draft.flush();
	return { ...fixture, draft };
}

describe('explicit ticket draft discard', () => {
	it('clears feedback and saved recovery on one click', async () => {
		const { controller, draft, recovery } = await draftFixture();
		draft.error = 'Synthetic failed submission';
		render(TicketDraftFeedback, { draft });
		expect(recovery.list(draft.current)).toHaveLength(1);
		await fireEvent.click(screen.getByRole('button', { name: 'Discard draft' }));
		expect(draft.current.fields).toEqual({});
		expect(draft.error).toBeNull();
		expect(controller.drafts.needsExitGuard).toBe(false);
		expect(recovery.list(draft.current)).toHaveLength(0);
		expect(screen.queryByRole('button', { name: 'Keep editing' })).toBeNull();
	});

	it.each(['active', 'unreadable', 'old-store', 'memory-only'] as const)(
		'discards a %s recovery entry on one click',
		async (kind) => {
			const { controller, draft, recovery, storage } = await draftFixture();
			const snapshot = draft.current;
			if (kind === 'unreadable') {
				draft.discard();
				controller.drafts.releaseClean(draft);
				recovery.write(snapshot);
				storage.setItem(recovery.list(snapshot)[0].key, 'Synthetic unreadable recovery');
				controller.drafts.reloadRecovery();
			} else if (kind !== 'active') {
				controller.drafts.setPartition({
					...snapshot,
					storeId: '22222222-2222-4222-8222-222222222222',
				});
				if (kind === 'memory-only') {
					recovery.remove(snapshot, snapshot.id);
					controller.drafts.reloadRecovery();
				}
			}
			const view = render(TicketRecovery, { controller });
			await fireEvent.click(screen.getByText(/Recovered drafts/));
			expect(controller.drafts.needsExitGuard).toBe(true);
			await fireEvent.click(screen.getByRole('button', { name: 'Discard draft' }));
			expect(controller.drafts.needsExitGuard).toBe(false);
			expect(recovery.list(snapshot)).toHaveLength(0);
			expect(view.container.querySelector('.ticket-recovery-entry')).toBeNull();
			expect(screen.queryByRole('button', { name: 'Keep editing' })).toBeNull();
		},
	);

	it('does not discard an in-flight submission', async () => {
		const { controller, draft, api, recovery } = await draftFixture();
		let release!: () => void;
		api.mutate.mockImplementationOnce(
			() =>
				new Promise((_, reject) => {
					release = () => reject(new Error('Synthetic lost response'));
				}),
		);
		const submitting = draft.submit({
			action: 'create',
			input: { title: 'Synthetic unsaved title', project: 'Release' },
		});
		render(TicketDraftFeedback, { draft });
		const discard = screen.getByRole('button', { name: 'Discard draft' }) as HTMLButtonElement;
		expect(discard.disabled).toBe(true);
		await fireEvent.click(discard);
		expect(controller.drafts.needsExitGuard).toBe(true);
		expect(draft.current.fields.title).toBe('Synthetic unsaved title');
		expect(recovery.list(draft.current)).toHaveLength(1);
		release();
		await submitting;
		await fireEvent.click(screen.getByRole('button', { name: 'Discard draft' }));
		expect(controller.drafts.needsExitGuard).toBe(false);
	});
});
