import { fireEvent, render, screen } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import FileConflictComparison from '../FileConflictComparison.svelte';

describe('FileConflictComparison', () => {
	it('exposes complete tab semantics and explicit resolution actions', async () => {
		const onSaveChecked = vi.fn();
		const onOverwrite = vi.fn();
		render(FileConflictComparison, {
			baseContent: 'base',
			localContent: 'local',
			diskContent: 'disk',
			lineSeparator: '\n',
			onCancel: vi.fn(),
			onAcceptDisk: vi.fn(),
			onSaveChecked,
			onOverwrite,
		});

		const tabs = screen.getAllByRole('tab');
		expect(tabs.map((tab) => tab.textContent)).toEqual(['Base', 'Disk']);
		expect(tabs[1]?.getAttribute('aria-selected')).toBe('true');
		expect(screen.getByRole('tabpanel').getAttribute('aria-labelledby')).toBe(
			'file-conflict-disk-tab',
		);
		await fireEvent.click(screen.getByRole('button', { name: 'Save against displayed disk' }));
		await fireEvent.click(screen.getByRole('button', { name: 'Replace disk' }));
		expect(onSaveChecked).toHaveBeenCalledWith('local');
		expect(onOverwrite).toHaveBeenCalledWith('local');
	});

	it('disables every disk-mutating action when the disk snapshot is unavailable', () => {
		render(FileConflictComparison, {
			baseContent: 'base',
			localContent: 'local',
			diskContent: null,
			lineSeparator: '\n',
			onCancel: vi.fn(),
			onAcceptDisk: vi.fn(),
			onSaveChecked: vi.fn(),
			onOverwrite: vi.fn(),
		});

		expect(
			(screen.getByRole('button', { name: 'Accept disk' }) as HTMLButtonElement).disabled,
		).toBe(true);
		expect(
			(screen.getByRole('button', { name: 'Save against displayed disk' }) as HTMLButtonElement)
				.disabled,
		).toBe(true);
		expect(
			(screen.getByRole('button', { name: 'Replace disk' }) as HTMLButtonElement).disabled,
		).toBe(true);
	});
});
