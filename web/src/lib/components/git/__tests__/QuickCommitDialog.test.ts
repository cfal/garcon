import { cleanup, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import QuickCommitDialog from '../QuickCommitDialog.svelte';
import { QuickCommitDialogState } from '$lib/stores/git/quick-commit-dialog-state.svelte';

function makeDialog(): QuickCommitDialogState {
	return new QuickCommitDialogState({
		refreshSummary: vi.fn().mockResolvedValue(undefined),
		markProjectChanged: vi.fn(),
	});
}

describe('QuickCommitDialog', () => {
	afterEach(async () => {
		cleanup();
		// Allows Bits UI body-scroll-lock's delayed cleanup to run before happy-dom removes document.
		await new Promise((resolve) => window.setTimeout(resolve, 30));
	});

	it('does not intercept global commit shortcuts while closed', () => {
		const dialog = makeDialog();
		dialog.projectPath = '/project';
		dialog.message = 'test: commit';
		dialog.intents = {
			'a.ts': {
				path: 'a.ts',
				desiredSelected: true,
				actualSelected: true,
				isRunning: false,
				runningMode: null,
				error: null,
			},
		};

		render(QuickCommitDialog, {
			props: {
				dialog,
				isMobile: false,
			},
		});

		const event = new KeyboardEvent('keydown', {
			key: 'Enter',
			ctrlKey: true,
			cancelable: true,
		});

		expect(window.dispatchEvent(event)).toBe(true);
		expect(event.defaultPrevented).toBe(false);
	});

	it('contains Escape while open and reports close after the overlay is removed', async () => {
		const dialog = makeDialog();
		const onClosed = vi.fn();
		const laterWindowHandler = vi.fn();
		dialog.isOpen = true;
		dialog.projectPath = '/project';

		render(QuickCommitDialog, {
			props: {
				dialog,
				isMobile: false,
				onClosed,
			},
		});

		window.addEventListener('keydown', laterWindowHandler);
		try {
			const event = new KeyboardEvent('keydown', {
				key: 'Escape',
				cancelable: true,
			});

			expect(window.dispatchEvent(event)).toBe(false);
			expect(event.defaultPrevented).toBe(true);
			expect(laterWindowHandler).not.toHaveBeenCalled();
			expect(dialog.isOpen).toBe(false);

			await waitFor(() => expect(onClosed).toHaveBeenCalledOnce());
		} finally {
			window.removeEventListener('keydown', laterWindowHandler);
		}
	});

	it('asks users to select files when the dialog has no selected files', () => {
		const dialog = makeDialog();
		dialog.isOpen = true;
		dialog.projectPath = '/project';

		render(QuickCommitDialog, {
			props: {
				dialog,
				isMobile: false,
			},
		});

		expect(screen.getByText('Select files to commit')).toBeTruthy();
		expect(screen.queryByText('Commit 0 file(s)')).toBeNull();
	});

	it('shows the selected file count when files are selected', () => {
		const dialog = makeDialog();
		dialog.isOpen = true;
		dialog.projectPath = '/project';
		dialog.intents = {
			'a.ts': {
				path: 'a.ts',
				desiredSelected: true,
				actualSelected: true,
				isRunning: false,
				runningMode: null,
				error: null,
			},
		};

		render(QuickCommitDialog, {
			props: {
				dialog,
				isMobile: false,
			},
		});

		expect(screen.getByText('Commit 1 file(s)')).toBeTruthy();
	});
});
