import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, it } from 'vitest';
import DialogFocusRestoreHost from './DialogFocusRestoreHost.svelte';

describe('Dialog content focus restoration', () => {
	afterEach(() => {
		cleanup();
		document.body.innerHTML = '';
	});

	it('restores the trigger when registry Escape closes with body focused', async () => {
		render(DialogFocusRestoreHost);
		const trigger = screen.getByRole('button', { name: 'Open focus dialog' });
		trigger.focus();
		await fireEvent.click(trigger);
		await screen.findByRole('dialog', { name: 'Focus restore dialog' });
		const action = screen.getByRole('button', { name: 'Dialog action' });
		await waitFor(() => expect(document.activeElement).toBe(action));

		action.blur();
		expect(document.activeElement).toBe(document.body);
		await fireEvent.keyDown(window, { key: 'Escape' });

		await waitFor(() => {
			expect(screen.queryByRole('dialog', { name: 'Focus restore dialog' })).toBeNull();
			expect(document.activeElement).toBe(trigger);
		});
	});

	it('preserves focus claimed by another target while the dialog closes', async () => {
		render(DialogFocusRestoreHost, { claimFocusOnClose: true });
		const trigger = screen.getByRole('button', { name: 'Open focus dialog' });
		await fireEvent.click(trigger);
		await screen.findByRole('dialog', { name: 'Focus restore dialog' });
		const action = screen.getByRole('button', { name: 'Dialog action' });
		await waitFor(() => expect(document.activeElement).toBe(action));

		await fireEvent.keyDown(window, { key: 'Escape' });

		const outsideFocusTarget = screen.getByRole('button', { name: 'Outside focus target' });
		await waitFor(() => {
			expect(screen.queryByRole('dialog', { name: 'Focus restore dialog' })).toBeNull();
			expect(document.activeElement).toBe(outsideFocusTarget);
		});
	});
});
