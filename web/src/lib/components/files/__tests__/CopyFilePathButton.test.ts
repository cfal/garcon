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

		expect(copyToClipboard).toHaveBeenCalledWith('src/lib/example.ts', undefined);
		expect(screen.getByRole('button', { name: 'File path copied' })).toBeTruthy();
	});

	it('forwards the clipboard fallback container', async () => {
		copyToClipboard.mockResolvedValue(true);
		const container = document.createElement('div');
		render(CopyFilePathButton, { path: 'src/lib/example.ts', container });

		await fireEvent.click(screen.getByRole('button', { name: 'Copy file path' }));

		expect(copyToClipboard).toHaveBeenCalledWith('src/lib/example.ts', container);
	});

	it('keeps the copy affordance when clipboard access fails', async () => {
		copyToClipboard.mockResolvedValue(false);
		render(CopyFilePathButton, { path: 'src/lib/example.ts' });

		await fireEvent.click(screen.getByRole('button', { name: 'Copy file path' }));

		expect(screen.getByRole('button', { name: 'Copy file path' })).toBeTruthy();
	});

	it('only applies the latest overlapping copy result', async () => {
		let resolveFirstCopy!: (copied: boolean) => void;
		let resolveSecondCopy!: (copied: boolean) => void;
		copyToClipboard
			.mockReturnValueOnce(
				new Promise<boolean>((resolve) => {
					resolveFirstCopy = resolve;
				}),
			)
			.mockReturnValueOnce(
				new Promise<boolean>((resolve) => {
					resolveSecondCopy = resolve;
				}),
			);
		render(CopyFilePathButton, { path: 'src/lib/example.ts' });
		const button = screen.getByRole('button', { name: 'Copy file path' });

		await fireEvent.click(button);
		await fireEvent.click(button);
		resolveFirstCopy(true);
		await Promise.resolve();

		expect(screen.getByRole('button', { name: 'Copy file path' })).toBeTruthy();

		resolveSecondCopy(true);

		expect(await screen.findByRole('button', { name: 'File path copied' })).toBeTruthy();
	});

	it('does not schedule copied-state cleanup when copying finishes after unmount', async () => {
		let resolveCopy!: (copied: boolean) => void;
		copyToClipboard.mockReturnValue(
			new Promise<boolean>((resolve) => {
				resolveCopy = resolve;
			}),
		);
		const { unmount } = render(CopyFilePathButton, { path: 'src/lib/example.ts' });

		await fireEvent.click(screen.getByRole('button', { name: 'Copy file path' }));
		unmount();
		const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');

		resolveCopy(true);
		await Promise.resolve();

		expect(setTimeoutSpy).not.toHaveBeenCalled();
		setTimeoutSpy.mockRestore();
	});
});
