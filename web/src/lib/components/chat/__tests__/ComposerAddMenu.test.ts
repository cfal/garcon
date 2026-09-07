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

	it('attaches images from the menu when supported', async () => {
		render(ComposerAddMenuTestHost, { canAttachImages: true });
		await fireEvent.click(screen.getByRole('button', { name: 'Add to prompt' }));

		await fireEvent.click(screen.getByRole('menuitem', { name: /Add image/ }));

		expect(screen.getByTestId('image-picker-open-count').textContent).toBe('1');
		expect(screen.getByTestId('palette-open-count').textContent).toBe('0');
	});

	it('opens the snippet palette on every platform', async () => {
		render(ComposerAddMenuTestHost, { mobile: true });
		await fireEvent.click(screen.getByRole('button', { name: 'Add to prompt' }));

		await fireEvent.click(screen.getByRole('menuitem', { name: /Snippets/ }));

		expect(screen.getByTestId('palette-open-count').textContent).toBe('1');
		await waitFor(() =>
			expect(screen.queryByRole('menuitem', { name: /Snippets/ })).toBeNull(),
		);
	});

	it('opens a constrained menu above the composer', async () => {
		render(ComposerAddMenuTestHost, { canAttachImages: true });
		await fireEvent.click(screen.getByRole('button', { name: 'Add to prompt' }));

		const menu = screen.getByRole('menu');
		expect(menu.getAttribute('data-side')).toBe('top');
		expect(menu.classList.contains('w-64')).toBe(true);
		expect(menu.classList.contains('max-w-[calc(100vw-1rem)]')).toBe(true);
	});
});
