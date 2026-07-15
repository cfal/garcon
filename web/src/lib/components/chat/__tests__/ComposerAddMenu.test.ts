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

	it('collects arguments before inserting a desktop snippet that uses them', async () => {
		render(ComposerAddMenuTestHost, {
			count: 1,
			firstTemplate: 'Review {{arguments}} in {{project_path}}',
		});
		await fireEvent.click(screen.getByRole('button', { name: 'Add to prompt' }));
		await fireEvent.pointerMove(screen.getByRole('menuitem', { name: /Snippets/ }), {
			pointerType: 'mouse',
		});
		await fireEvent.click(await screen.findByRole('menuitem', { name: /\/snippet item-0/ }));

		const input = await screen.findByRole('textbox', { name: 'Arguments' });
		await fireEvent.input(input, { target: { value: 'the API boundaries' } });
		await fireEvent.keyDown(input, { key: 'Enter', shiftKey: true });
		expect(screen.getByRole('dialog', { name: 'Arguments for /snippet item-0' })).toBeTruthy();
		expect(screen.getByTestId('selected-snippet').textContent).toBe('');
		await fireEvent.keyDown(input, { key: 'Enter' });

		await waitFor(() =>
			expect(screen.queryByRole('dialog', { name: 'Arguments for /snippet item-0' })).toBeNull(),
		);
		expect(screen.getByTestId('selected-snippet').textContent).toBe('item-0');
		expect(screen.getByTestId('selected-arguments').textContent).toBe('the API boundaries');
	});

	it('does not prompt for an escaped arguments marker', async () => {
		render(ComposerAddMenuTestHost, {
			count: 1,
			firstTemplate: 'Keep \\{{arguments}} literal',
		});
		await fireEvent.click(screen.getByRole('button', { name: 'Add to prompt' }));
		await fireEvent.pointerMove(screen.getByRole('menuitem', { name: /Snippets/ }), {
			pointerType: 'mouse',
		});
		await fireEvent.click(await screen.findByRole('menuitem', { name: /\/snippet item-0/ }));

		expect(screen.queryByRole('textbox', { name: 'Arguments' })).toBeNull();
		expect(screen.getByTestId('selected-snippet').textContent).toBe('item-0');
		expect(screen.getByTestId('selected-arguments').textContent).toBe('');
	});

	it('cancels argument entry without inserting and restores composer focus', async () => {
		render(ComposerAddMenuTestHost, {
			count: 1,
			firstTemplate: 'Review {{arguments}}',
		});
		const composer = screen.getByRole('textbox', { name: 'Composer prompt' });
		composer.focus();
		await fireEvent.click(screen.getByRole('button', { name: 'Add to prompt' }));
		await fireEvent.pointerMove(screen.getByRole('menuitem', { name: /Snippets/ }), {
			pointerType: 'mouse',
		});
		await fireEvent.click(await screen.findByRole('menuitem', { name: /\/snippet item-0/ }));

		const dialog = await screen.findByRole('dialog', {
			name: 'Arguments for /snippet item-0',
		});
		await fireEvent.keyDown(dialog, { key: 'Escape' });

		await waitFor(() => expect(document.activeElement).toBe(composer));
		expect(screen.getByTestId('selected-snippet').textContent).toBe('');
	});

	it('restores composer focus when the mobile picker is dismissed', async () => {
		render(ComposerAddMenuTestHost, { mobile: true });
		const composer = screen.getByRole('textbox', { name: 'Composer prompt' });
		composer.focus();
		await fireEvent.click(screen.getByRole('button', { name: 'Add to prompt' }));
		await fireEvent.click(screen.getByRole('menuitem', { name: /Snippets/ }));

		const dialog = await screen.findByRole('dialog', { name: 'Insert Snippet' });
		await fireEvent.keyDown(dialog, { key: 'Escape' });

		await waitFor(() => expect(document.activeElement).toBe(composer));
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

	it('collects arguments after selecting from the mobile picker', async () => {
		render(ComposerAddMenuTestHost, {
			mobile: true,
			count: 1,
			firstTemplate: 'Summarize {{arguments}}',
		});
		await fireEvent.click(screen.getByRole('button', { name: 'Add to prompt' }));
		await fireEvent.click(screen.getByRole('menuitem', { name: /Snippets/ }));
		await fireEvent.click(await screen.findByRole('button', { name: /\/snippet item-0/ }));

		const input = await screen.findByRole('textbox', { name: 'Arguments' });
		await fireEvent.input(input, { target: { value: 'release notes' } });
		await fireEvent.click(screen.getByRole('button', { name: 'Insert snippet' }));

		await waitFor(() => expect(screen.getByTestId('selected-snippet').textContent).toBe('item-0'));
		expect(screen.getByTestId('selected-arguments').textContent).toBe('release notes');
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
