import { render, screen } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import SplitResizer from '../SplitResizer.svelte';

describe('SplitResizer', () => {
	it('keeps a narrow visible track for horizontal splits', () => {
		render(SplitResizer, { direction: 'horizontal', onResize: vi.fn() });

		const separator = screen.getByRole('separator', { name: 'Resize panes' });
		expect(separator.className).toContain('w-1');
		expect(separator.className).not.toContain('w-1.5');
		expect(separator.getAttribute('aria-orientation')).toBe('vertical');
	});

	it('keeps a narrow visible track for vertical splits', () => {
		render(SplitResizer, { direction: 'vertical', onResize: vi.fn() });

		const separator = screen.getByRole('separator', { name: 'Resize panes' });
		expect(separator.className).toContain('h-1');
		expect(separator.className).not.toContain('h-1.5');
		expect(separator.getAttribute('aria-orientation')).toBe('horizontal');
	});
});
