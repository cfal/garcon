import { fireEvent, render, screen } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import ResizeHandle from '../ResizeHandle.svelte';

describe('ResizeHandle', () => {
	it.each([
		['end' as const, 450, 'end-0'],
		['start' as const, 350, 'start-0'],
	])('resizes from the %s edge', async (edge, expectedWidth, positionClass) => {
		const onResize = vi.fn();
		render(ResizeHandle, { width: 400, edge, onResize });
		const separator = screen.getByRole('separator') as HTMLElement;
		separator.setPointerCapture = vi.fn();
		expect(separator.parentElement?.classList).toContain(positionClass);

		await fireEvent.pointerDown(separator, { pointerId: 4, clientX: 500 });
		await fireEvent.pointerMove(separator, { pointerId: 4, clientX: 550 });

		expect(onResize).toHaveBeenCalledWith(expectedWidth);
	});

	it.each([
		['end' as const, 350],
		['start' as const, 450],
	])('resizes from the logical %s edge in RTL', async (edge, expectedWidth) => {
		const onResize = vi.fn();
		render(ResizeHandle, { width: 400, edge, onResize });
		const separator = screen.getByRole('separator') as HTMLElement;
		separator.style.direction = 'rtl';
		separator.setPointerCapture = vi.fn();

		await fireEvent.pointerDown(separator, { pointerId: 5, clientX: 500 });
		await fireEvent.pointerMove(separator, { pointerId: 5, clientX: 550 });

		expect(onResize).toHaveBeenCalledWith(expectedWidth);
	});
});
