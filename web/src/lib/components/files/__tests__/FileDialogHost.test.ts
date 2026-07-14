import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import FileDialogHostTestHost from './FileDialogHostTestHost.svelte';

describe('FileDialogHost', () => {
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
