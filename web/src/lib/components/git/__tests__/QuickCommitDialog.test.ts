import { cleanup, render, screen } from '@testing-library/svelte';
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
	afterEach(() => {
		cleanup();
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
