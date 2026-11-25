import { fireEvent, render, screen } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import ResizeHandle from '../ResizeHandle.svelte';

describe('ResizeHandle', () => {
	it.each([
		['end' as const, 450, 'end-0'],
		['start' as const, 350, 'start-0'],
	])('resizes from the %s edge', async (edge, expectedWidth, positionClass) => {
		const onPreview = vi.fn();
		const onCommit = vi.fn();
		render(ResizeHandle, { width: 400, edge, onPreview, onCommit });
		const separator = screen.getByRole('separator') as HTMLElement;
		separator.setPointerCapture = vi.fn();
		expect(separator.parentElement?.classList).toContain(positionClass);

		await fireEvent.pointerDown(separator, { pointerId: 4, clientX: 500, isPrimary: true });
		await fireEvent.pointerMove(separator, { pointerId: 4, clientX: 550 });
		await fireEvent.pointerMove(separator, { pointerId: 9, clientX: 800 });
		await fireEvent.pointerUp(separator, { pointerId: 9 });

		expect(onPreview.mock.calls).toEqual([[expectedWidth]]);
		expect(onCommit).not.toHaveBeenCalled();
		await fireEvent.pointerUp(separator, { pointerId: 4 });
		expect(onCommit.mock.calls).toEqual([[expectedWidth]]);
		expect(onPreview).toHaveBeenLastCalledWith(null);
	});

	it.each([
		['end' as const, 350],
		['start' as const, 450],
	])('resizes from the logical %s edge in RTL', async (edge, expectedWidth) => {
		const onPreview = vi.fn();
		render(ResizeHandle, { width: 400, edge, onPreview, onCommit: vi.fn() });
		const separator = screen.getByRole('separator') as HTMLElement;
		separator.style.direction = 'rtl';
		separator.setPointerCapture = vi.fn();

		await fireEvent.pointerDown(separator, { pointerId: 5, clientX: 500, isPrimary: true });
		await fireEvent.pointerMove(separator, { pointerId: 5, clientX: 550 });

		expect(onPreview).toHaveBeenCalledWith(expectedWidth);
	});

	it('uses a line-only active indicator while resizing', async () => {
		render(ResizeHandle, { width: 400, onPreview: vi.fn(), onCommit: vi.fn() });
		const separator = screen.getByRole('separator') as HTMLElement;
		separator.setPointerCapture = vi.fn();

		await fireEvent.pointerDown(separator, { pointerId: 6, clientX: 500, isPrimary: true });

		expect(separator.classList).not.toContain('bg-primary/10');
		expect(separator.firstElementChild?.classList).toContain('bg-primary/30');
	});

	it('ignores non-primary input and clears cancelled and unmounted drags', async () => {
		const onPreview = vi.fn();
		const onCommit = vi.fn();
		const { unmount } = render(ResizeHandle, { width: 400, onPreview, onCommit });
		const separator = screen.getByRole('separator');
		await fireEvent.pointerDown(separator, { pointerId: 1, button: 2, isPrimary: true });
		await fireEvent.pointerDown(separator, { pointerId: 1, isPrimary: false });
		await fireEvent.pointerMove(separator, { pointerId: 1, clientX: 50 });
		expect(onPreview).not.toHaveBeenCalled();
		await fireEvent.pointerDown(separator, { pointerId: 2, isPrimary: true });
		await fireEvent.pointerMove(separator, { pointerId: 2, clientX: 50 });
		await fireEvent.pointerCancel(separator, { pointerId: 2 });
		expect(onPreview.mock.calls).toEqual([[450], [null]]);
		await fireEvent.pointerDown(separator, { pointerId: 3, isPrimary: true });
		await fireEvent.pointerMove(separator, { pointerId: 3, clientX: 60 });
		unmount();
		await fireEvent.pointerUp(separator, { pointerId: 3 });
		expect(onPreview.mock.calls).toEqual([[450], [null], [460], [null]]);
		expect(onCommit).not.toHaveBeenCalled();
	});

	it('exposes a keyboard-resizable range and clamps the committed width', async () => {
		const onCommit = vi.fn();
		render(ResizeHandle, { width: 550, onPreview: vi.fn(), onCommit });
		const separator = screen.getByRole('separator');
		expect(separator.getAttribute('tabindex')).toBe('0');
		expect(separator.getAttribute('aria-valuemin')).toBe('240');
		expect(separator.getAttribute('aria-valuemax')).toBe('560');
		expect(separator.getAttribute('aria-valuenow')).toBe('550');
		await fireEvent.keyDown(separator, { key: 'ArrowRight' });
		expect(onCommit).toHaveBeenCalledWith(560);
	});
});
