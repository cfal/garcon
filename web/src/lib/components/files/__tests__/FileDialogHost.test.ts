import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import * as m from '$lib/paraglide/messages.js';
import { createNotificationsStore } from '$lib/stores/notifications.svelte.js';
import FileDialogHostTestHost from './FileDialogHostTestHost.svelte';

describe('FileDialogHost', () => {
	it('offers one move-to-window control for the dialog file', async () => {
		const onMove = vi.fn();
		render(FileDialogHostTestHost, { request: 'file', onMove });
		const moveButtons = await screen.findAllByRole('button', {
			name: m.file_session_move_to_window(),
		});
		expect(moveButtons).toHaveLength(1);
		expect(moveButtons[0].querySelector('.lucide-panel-left')).toBeTruthy();

		await fireEvent.click(moveButtons[0]);
		expect(onMove).toHaveBeenCalledWith('window-main');
	});

	it('reports a failed move to the destination window', async () => {
		const notifications = createNotificationsStore();
		render(FileDialogHostTestHost, {
			request: 'file',
			moveError: new Error('Destination window is no longer available'),
			notifications,
		});

		await fireEvent.click(
			await screen.findByRole('button', { name: m.file_session_move_to_window() }),
		);

		await waitFor(() => expect(notifications.items).toHaveLength(1));
		expect(notifications.items[0]).toMatchObject({
			tone: 'error',
			message: 'Destination window is no longer available',
		});
	});

	it('overrides the shared responsive width cap in restored and maximized layouts', async () => {
		const rendered = render(FileDialogHostTestHost, { request: 'file' });
		const dialog = await screen.findByRole('dialog');

		expect(dialog.dataset.workspaceSurfaceId).toMatch(/^file:/);
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

	it('keeps one dialog-owned Close control', async () => {
		const rendered = render(FileDialogHostTestHost, { request: 'file' });
		await screen.findByRole('dialog');

		expect(await screen.findAllByRole('button', { name: m.file_session_close() })).toHaveLength(1);
		rendered.unmount();
	});

	it('does not open the desktop file dialog on mobile', () => {
		const rendered = render(FileDialogHostTestHost, { request: 'file', isMobile: true });

		expect(screen.queryByRole('dialog')).toBeNull();
		rendered.unmount();
	});

	it('limits file-threshold decisions to cancel or opening anyway', async () => {
		const rendered = render(FileDialogHostTestHost, {
			request: 'threshold',
		});

		await screen.findByRole('dialog');
		expect(screen.getAllByRole('button').map((button) => button.textContent)).toEqual([
			m.file_session_cancel(),
			m.file_session_open_anyway(),
		]);
		rendered.unmount();
	});

	it('resolves a dirty-file guard as Cancel when Escape dismisses it', async () => {
		const onResolve = vi.fn();
		render(FileDialogHostTestHost, { request: 'guard', onResolve });
		await screen.findByRole('dialog');

		await fireEvent.keyDown(document, { key: 'Escape' });

		await waitFor(() => expect(onResolve).toHaveBeenCalledWith('cancel'));
	});

	it('uses a discard-only confirmation for a dirty refresh', async () => {
		const onResolve = vi.fn();
		render(FileDialogHostTestHost, { request: 'refresh', onResolve });

		expect(await screen.findByText(m.file_session_discard_refresh_title())).toBeTruthy();
		expect(screen.queryByRole('button', { name: m.file_session_save() })).toBeNull();
		await fireEvent.click(
			screen.getByRole('button', { name: m.file_session_discard_and_refresh() }),
		);
		expect(onResolve).toHaveBeenCalledWith('discard');
	});

	it('requires an explicit destructive choice before overwriting external changes', async () => {
		const onResolve = vi.fn();
		render(FileDialogHostTestHost, { request: 'overwrite', onResolve });

		expect(await screen.findByText(m.file_session_overwrite_title())).toBeTruthy();
		const overwrite = screen.getByRole('button', { name: m.file_session_save_anyway() });
		expect(overwrite.getAttribute('data-slot')).toBe('button');
		expect(overwrite.className).toContain('bg-destructive');
		await fireEvent.click(overwrite);
		expect(onResolve).toHaveBeenCalledWith('overwrite');
	});

	it('cancels an overwrite request when Escape dismisses it', async () => {
		const onResolve = vi.fn();
		render(FileDialogHostTestHost, { request: 'overwrite', onResolve });
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
