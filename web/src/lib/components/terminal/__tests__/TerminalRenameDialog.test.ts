import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TERMINAL_TITLE_MAX_LENGTH, type TerminalMetadata } from '$shared/terminal';
import TerminalRenameDialog from '../TerminalRenameDialog.svelte';

function metadata(title: string | null): TerminalMetadata {
	return {
		terminalId: 'terminal-1',
		displaySequence: 4,
		title,
		initialWorkingDirectory: '/workspace',
		processStatus: 'running',
		attachmentStatus: 'attached',
		createdAt: '2026-08-31T00:00:00.000Z',
		exitCode: null,
		latestOutputSequence: 0,
	};
}

describe('TerminalRenameDialog', () => {
	afterEach(cleanup);

	it('selects the current title and submits a blank value to restore the default', async () => {
		const onClose = vi.fn();
		const onRename = vi.fn(async () => undefined);
		render(TerminalRenameDialog, {
			terminal: metadata('Build logs'),
			onClose,
			onRename,
		});

		const input = await screen.findByRole('textbox', { name: 'Terminal name' });
		expect((input as HTMLInputElement).value).toBe('Build logs');
		expect(input.getAttribute('maxlength')).toBe(String(TERMINAL_TITLE_MAX_LENGTH));
		expect(screen.getByText('Leave blank to use Terminal 4.')).toBeTruthy();

		await fireEvent.input(input, { target: { value: '' } });
		await fireEvent.click(screen.getByRole('button', { name: 'Save' }));

		await waitFor(() => expect(onRename).toHaveBeenCalledWith('terminal-1', ''));
		expect(onClose).toHaveBeenCalledOnce();
	});

	it('keeps the dialog open and surfaces rename failures', async () => {
		const onClose = vi.fn();
		const onRename = vi.fn(async () => {
			throw new Error('Rename unavailable');
		});
		render(TerminalRenameDialog, {
			terminal: metadata(null),
			onClose,
			onRename,
		});

		const input = await screen.findByRole('textbox', { name: 'Terminal name' });
		await fireEvent.input(input, { target: { value: 'Dev server' } });
		await fireEvent.click(screen.getByRole('button', { name: 'Save' }));

		expect((await screen.findByRole('alert')).textContent).toContain('Rename unavailable');
		expect(onClose).not.toHaveBeenCalled();
	});
});
