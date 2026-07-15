import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, it } from 'vitest';
import ComposerAddMenuTestHost from './ComposerAddMenuTestHost.svelte';

describe('ComposerAddMenu', () => {
	afterEach(cleanup);

	it('keeps snippets reachable when images are unsupported', async () => {
		render(ComposerAddMenuTestHost, { canAttachImages: false });
		const trigger = screen.getByRole('button', { name: 'Add to prompt' }) as HTMLButtonElement;
		expect(trigger.disabled).toBe(false);

		await fireEvent.click(trigger);

		expect(screen.getByRole('menuitem', { name: /Add image/ }).hasAttribute('data-disabled')).toBe(
			true,
		);
		expect(screen.getByRole('menuitem', { name: /Snippets/ })).toBeTruthy();
	});

	it('shows the complete ordered desktop list in the submenu', async () => {
		render(ComposerAddMenuTestHost, { count: 12 });
		await fireEvent.click(screen.getByRole('button', { name: 'Add to prompt' }));
		const snippetsItem = screen.getByRole('menuitem', { name: /Snippets/ });
		await fireEvent.pointerMove(snippetsItem, { pointerType: 'mouse' });

		await waitFor(() => expect(screen.getByText('/snippet item-11')).toBeTruthy());
		const names = screen.getAllByText(/^\/snippet item-/).map((entry) => entry.textContent);
		expect(names).toEqual(Array.from({ length: 12 }, (_, index) => `/snippet item-${index}`));
		expect(screen.getByRole('menuitem', { name: 'Edit snippets' })).toBeTruthy();
		const submenu = document.querySelector('[data-slot="dropdown-menu-sub-content"]');
		expect(submenu?.className).toContain('var(--bits-menu-content-available-height)');

		await fireEvent.click(screen.getByRole('menuitem', { name: /\/snippet item-7/ }));
		expect(screen.getByTestId('selected-snippet').textContent).toBe('item-7');
	});

	it('opens a searchable picker dialog on mobile and preserves match order', async () => {
		render(ComposerAddMenuTestHost, { mobile: true, count: 12 });
		await fireEvent.click(screen.getByRole('button', { name: 'Add to prompt' }));
		await fireEvent.click(screen.getByRole('menuitem', { name: /Snippets/ }));

		expect(await screen.findByRole('dialog', { name: 'Insert Snippet' })).toBeTruthy();
		const search = screen.getByRole('searchbox', { name: 'Search snippets' });
		await fireEvent.input(search, { target: { value: 'summarize' } });
		const names = screen.getAllByText(/^\/snippet item-/).map((entry) => entry.textContent);
		expect(names).toEqual([
			'/snippet item-1',
			'/snippet item-3',
			'/snippet item-5',
			'/snippet item-7',
			'/snippet item-9',
			'/snippet item-11',
		]);

		await fireEvent.click(screen.getByRole('button', { name: /\/snippet item-7/ }));
		await waitFor(() =>
			expect(screen.queryByRole('dialog', { name: 'Insert Snippet' })).toBeNull(),
		);
		expect(screen.getByTestId('selected-snippet').textContent).toBe('item-7');
	});

	it('keeps the desktop submenu open when retrying a failed load', async () => {
		render(ComposerAddMenuTestHost, { failLoads: true });
		await fireEvent.click(screen.getByRole('button', { name: 'Add to prompt' }));
		await fireEvent.pointerMove(screen.getByRole('menuitem', { name: /Snippets/ }), {
			pointerType: 'mouse',
		});

		await fireEvent.click(await screen.findByRole('menuitem', { name: 'Retry' }));

		await waitFor(() => expect(screen.getByTestId('load-count').textContent).toBe('2'));
		expect(screen.getByRole('menuitem', { name: 'Retry' })).toBeTruthy();
		expect(screen.getByRole('menuitem', { name: 'Edit snippets' })).toBeTruthy();
	});

	it('keeps the mobile picker open when retrying a failed load', async () => {
		render(ComposerAddMenuTestHost, { mobile: true, failLoads: true });
		await fireEvent.click(screen.getByRole('button', { name: 'Add to prompt' }));
		await fireEvent.click(screen.getByRole('menuitem', { name: /Snippets/ }));

		const dialog = await screen.findByRole('dialog', { name: 'Insert Snippet' });
		await fireEvent.click(await screen.findByRole('button', { name: 'Retry' }));

		await waitFor(() => expect(screen.getByTestId('load-count').textContent).toBe('2'));
		expect(dialog.isConnected).toBe(true);
		expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
	});
});
