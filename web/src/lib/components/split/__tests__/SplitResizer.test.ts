import { fireEvent, render, screen } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import SplitResizer from '../SplitResizer.svelte';
import type { SplitDirection } from '$lib/stores/split-layout.svelte';

function renderResizer(direction: SplitDirection) {
	const onResizeStart = vi.fn();
	const onResize = vi.fn();
	const onReset = vi.fn();
	render(SplitResizer, { direction, onResizeStart, onResize, onReset });
	return { onResizeStart, onResize, onReset };
}

describe('SplitResizer', () => {
	it('keeps a narrow visible track for horizontal splits', () => {
		renderResizer('horizontal');

		const separator = screen.getByRole('separator', { name: 'Resize panes' });
		expect(separator.className).toContain('w-1');
		expect(separator.className).not.toContain('w-1.5');
		expect(separator.getAttribute('aria-orientation')).toBe('vertical');
	});

	it('keeps a narrow visible track for vertical splits', () => {
		renderResizer('vertical');

		const separator = screen.getByRole('separator', { name: 'Resize panes' });
		expect(separator.className).toContain('h-1');
		expect(separator.className).not.toContain('h-1.5');
		expect(separator.getAttribute('aria-orientation')).toBe('horizontal');
	});

	it('is keyboard focusable and resizes with arrow keys', async () => {
		const { onResizeStart, onResize } = renderResizer('horizontal');

		const separator = screen.getByRole('separator', { name: 'Resize panes' });
		expect(separator.getAttribute('tabindex')).toBe('0');

		await fireEvent.keyDown(separator, { key: 'ArrowRight' });
		expect(onResizeStart).toHaveBeenCalledTimes(1);
		expect(onResize).toHaveBeenCalledWith(24);

		await fireEvent.keyDown(separator, { key: 'ArrowLeft' });
		expect(onResize).toHaveBeenCalledWith(-24);
	});

	it('ignores arrow keys along the non-resize axis', async () => {
		const { onResize } = renderResizer('horizontal');

		const separator = screen.getByRole('separator', { name: 'Resize panes' });
		await fireEvent.keyDown(separator, { key: 'ArrowUp' });
		await fireEvent.keyDown(separator, { key: 'ArrowDown' });

		expect(onResize).not.toHaveBeenCalled();
	});

	it('resets the split on double click', async () => {
		const { onReset } = renderResizer('vertical');

		const separator = screen.getByRole('separator', { name: 'Resize panes' });
		await fireEvent.dblClick(separator);

		expect(onReset).toHaveBeenCalledTimes(1);
	});
});
