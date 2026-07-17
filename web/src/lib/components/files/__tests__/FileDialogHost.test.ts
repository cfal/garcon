import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import * as m from '$lib/paraglide/messages.js';
import FileDialogHostTestHost from './FileDialogHostTestHost.svelte';

describe('FileDialogHost', () => {
	it('overrides the shared responsive width cap in restored and maximized layouts', async () => {
		const rendered = render(FileDialogHostTestHost, { request: 'file' });
		const dialog = await screen.findByRole('dialog');

		expect(dialog.classList.contains('sm:max-w-none')).toBe(true);
		expect(dialog.classList.contains('sm:max-w-lg')).toBe(false);

		await fireEvent.click(
			await screen.findByRole('button', { name: m.file_session_maximize_dialog() }),
		);

		expect(dialog.classList.contains('w-screen')).toBe(true);
		expect(dialog.classList.contains('sm:max-w-none')).toBe(true);
		expect(dialog.classList.contains('sm:max-w-lg')).toBe(false);
		rendered.unmount();
	});

	it('does not open the desktop file dialog on mobile', () => {
		const rendered = render(FileDialogHostTestHost, { request: 'file', isMobile: true });

		expect(screen.queryByRole('dialog')).toBeNull();
		rendered.unmount();
	});

	it('does not present File Sessions on mobile', () => {
		const rendered = render(FileDialogHostTestHost, {
			request: 'open-files',
			isMobile: true,
		});

		expect(screen.queryByRole('dialog')).toBeNull();
		rendered.unmount();
	});

	it('omits File Sessions recovery from the mobile threshold dialog', async () => {
		const rendered = render(FileDialogHostTestHost, {
			request: 'threshold',
			isMobile: true,
		});

		await screen.findByRole('dialog');
		expect(screen.queryByRole('button', { name: m.file_session_review_open() })).toBeNull();
		expect(screen.getByRole('button', { name: m.file_session_open_anyway() })).toBeTruthy();
		rendered.unmount();
	});

	it('resolves a dirty-file guard as Cancel when Escape dismisses it', async () => {
		const onResolve = vi.fn();
		render(FileDialogHostTestHost, { request: 'guard', onResolve });
		await screen.findByRole('dialog');

		await fireEvent.keyDown(document, { key: 'Escape' });

		await waitFor(() => expect(onResolve).toHaveBeenCalledWith('cancel'));
	});

	it('resolves a file-threshold request as Cancel when Escape dismisses it', async () => {
		const onResolve = vi.fn();
		render(FileDialogHostTestHost, { request: 'threshold', onResolve });
		await screen.findByRole('dialog');

		await fireEvent.keyDown(document, { key: 'Escape' });

		await waitFor(() => expect(onResolve).toHaveBeenCalledWith('cancel'));
	});
});
