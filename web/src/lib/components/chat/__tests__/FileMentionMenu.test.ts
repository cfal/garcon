import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import FileMentionMenu from '../FileMentionMenu.svelte';
import { getFileList } from '$lib/api/files.js';

vi.mock('$lib/api/files.js', () => ({
	getFileList: vi.fn(),
}));

describe('FileMentionMenu', () => {
	it('shows project-relative files and excludes directory entries', async () => {
		vi.mocked(getFileList).mockResolvedValue([
			{ name: 'src', path: '/repo/src', type: 'directory' },
			{ name: 'main.ts', path: '/repo/src/main.ts', relativePath: 'src/main.ts', type: 'file' },
		]);
		const onSelect = vi.fn();

		render(FileMentionMenu, {
			projectPath: '/repo',
			isVisible: true,
			query: 'main',
			onSelect,
			onClose: vi.fn(),
		});

		const item = await screen.findByRole('button', { name: /src\/main\.ts/ });
		expect(screen.queryByText('/repo/src')).toBeNull();

		await fireEvent.click(item);

		expect(onSelect).toHaveBeenCalledWith('src/main.ts');
	});

	it('supports keyboard selection through its public handler', async () => {
		vi.mocked(getFileList).mockResolvedValue([
			{ name: 'a.ts', path: '/repo/a.ts', relativePath: 'a.ts', type: 'file' },
			{ name: 'b.ts', path: '/repo/b.ts', relativePath: 'b.ts', type: 'file' },
		]);
		const onSelect = vi.fn();
		const { component } = render(FileMentionMenu, {
			projectPath: '/repo',
			isVisible: true,
			query: '',
			onSelect,
			onClose: vi.fn(),
		});

		await waitFor(() => {
			expect(screen.getByText('a.ts')).toBeTruthy();
			expect(screen.getByText('b.ts')).toBeTruthy();
		});

		component.handleKeyDown(new KeyboardEvent('keydown', { key: 'ArrowDown' }));
		component.handleKeyDown(new KeyboardEvent('keydown', { key: 'Enter' }));

		expect(onSelect).toHaveBeenCalledWith('b.ts');
	});
});
