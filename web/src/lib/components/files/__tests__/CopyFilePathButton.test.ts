import { fireEvent, render, screen } from '@testing-library/svelte';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import CopyFilePathButton from '../CopyFilePathButton.svelte';

const { copyToClipboard } = vi.hoisted(() => ({
	copyToClipboard: vi.fn(),
}));

vi.mock('$lib/utils/clipboard', () => ({ copyToClipboard }));

describe('CopyFilePathButton', () => {
	beforeEach(() => {
		copyToClipboard.mockReset();
	});

	it('copies the project-relative path and confirms success', async () => {
		copyToClipboard.mockResolvedValue(true);
		render(CopyFilePathButton, { path: 'src/lib/example.ts' });

		await fireEvent.click(screen.getByRole('button', { name: 'Copy file path' }));

		expect(copyToClipboard).toHaveBeenCalledWith('src/lib/example.ts');
		expect(screen.getByRole('button', { name: 'File path copied' })).toBeTruthy();
	});

	it('keeps the copy affordance when clipboard access fails', async () => {
		copyToClipboard.mockResolvedValue(false);
		render(CopyFilePathButton, { path: 'src/lib/example.ts' });

		await fireEvent.click(screen.getByRole('button', { name: 'Copy file path' }));

		expect(screen.getByRole('button', { name: 'Copy file path' })).toBeTruthy();
	});
});
