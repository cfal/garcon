import { fireEvent, render, screen } from '@testing-library/svelte';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FileTreeStore } from '$lib/files/tree/file-tree.svelte.js';
import { LOCAL_STORAGE_KEYS } from '$lib/utils/local-persistence';
import FileTreeColumnHeader from '../FileTreeColumnHeader.svelte';

vi.mock('$lib/api/files', () => ({
	getTree: vi.fn(),
}));

describe('FileTreeColumnHeader', () => {
	beforeEach(() => {
		localStorage.clear();
	});

	it('renders an accessible resize handle for each visible column boundary', async () => {
		const store = new FileTreeStore();
		render(FileTreeColumnHeader, { store, ariaRowIndex: 1 });

		expect(screen.getAllByRole('row')[0]?.getAttribute('aria-rowindex')).toBe('1');
		expect(screen.getAllByRole('slider')).toHaveLength(2);
		const firstHandle = screen.getByRole('slider', { name: 'Resize Name and Size columns' });
		expect(firstHandle.parentElement?.classList.contains('inset-y-0')).toBe(true);
		expect(firstHandle.parentElement?.classList.contains('-inset-y-1')).toBe(false);
		expect(firstHandle.classList.contains('-inset-y-1')).toBe(true);
		expect(screen.queryByText('Permissions')).toBeNull();

		store.setColumnVisible('permissions', true);
		await Promise.resolve();
		expect(
			screen.getByRole('slider', { name: 'Resize Modified and Permissions columns' }),
		).toBeTruthy();
	});

	it('resizes and persists columns from the keyboard', async () => {
		const store = new FileTreeStore();
		render(FileTreeColumnHeader, { store, ariaRowIndex: 1 });
		const handle = screen.getByRole('slider', { name: 'Resize Name and Size columns' });

		await fireEvent.keyDown(handle, { key: 'ArrowRight' });
		expect(store.columnWidths.name).toBeCloseTo(43.67, 2);
		expect(store.columnWidths.size).toBeCloseTo(14.83, 2);
		expect(JSON.parse(localStorage.getItem(LOCAL_STORAGE_KEYS.fileTreeColumnWidths) ?? '')).toEqual(
			store.columnWidths,
		);

		await fireEvent.doubleClick(handle);
		expect(store.columnWidths).toEqual({
			name: 42,
			size: 16.5,
			modified: 25,
			permissions: 16.5,
		});
	});

	it('previews pointer movement and persists it on release', async () => {
		const store = new FileTreeStore();
		const { container } = render(FileTreeColumnHeader, { store, ariaRowIndex: 1 });
		const grid = container.querySelector<HTMLElement>('[data-file-tree-column-grid]');
		const handle = screen.getByRole('slider', {
			name: 'Resize Name and Size columns',
		}) as HTMLElement;
		if (!grid) throw new Error('Expected the file tree column grid');
		grid.getBoundingClientRect = vi.fn(() => ({ width: 1000 }) as DOMRect);
		handle.setPointerCapture = vi.fn();
		handle.hasPointerCapture = vi.fn(() => true);
		handle.releasePointerCapture = vi.fn();

		await fireEvent.pointerDown(handle, {
			pointerId: 7,
			clientX: 400,
			button: 0,
			isPrimary: true,
		});
		await fireEvent.pointerMove(handle, { pointerId: 7, clientX: 440 });

		expect(store.columnWidths.name).toBeCloseTo(45.34, 2);
		expect(store.columnWidths.size).toBeCloseTo(13.16, 2);
		expect(localStorage.getItem(LOCAL_STORAGE_KEYS.fileTreeColumnWidths)).toBeNull();

		await fireEvent.pointerUp(handle, { pointerId: 7, clientX: 440 });
		expect(JSON.parse(localStorage.getItem(LOCAL_STORAGE_KEYS.fileTreeColumnWidths) ?? '')).toEqual(
			store.columnWidths,
		);
	});
});
