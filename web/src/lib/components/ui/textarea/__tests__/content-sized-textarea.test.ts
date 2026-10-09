import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import Textarea from '../textarea.svelte';
import {
	installResizeObserverHarness,
	ResizeObserverHarness,
} from '$lib/components/shared/__tests__/resize-observer-harness.js';

afterEach(cleanup);

describe('content-sized textarea', () => {
	it('fits restored values, typing, and programmatic clearing including its borders', async () => {
		const { rerender } = render(Textarea, { value: '' });
		const textarea = screen.getByRole<HTMLTextAreaElement>('textbox');
		textarea.style.boxSizing = 'border-box';
		textarea.style.border = '1px solid';
		Object.defineProperty(textarea, 'scrollHeight', {
			get: () => (textarea.value.length > 10 ? 120 : 42),
		});
		await rerender({ value: 'A synthetic restored multiline draft' });
		expect(textarea.style.height).toBe('122px');
		await fireEvent.input(textarea, { target: { value: 'Short' } });
		expect(textarea.style.height).toBe('44px');
		await rerender({ value: '' });
		expect(textarea.style.height).toBe('44px');
	});

	it('refits wrapped content when its panel width changes and releases the observer', async () => {
		const restore = installResizeObserverHarness();
		try {
			const { unmount } = render(Textarea, { value: 'A synthetic draft' });
			const textarea = screen.getByRole<HTMLTextAreaElement>('textbox');
			let measuredHeight = 100;
			Object.defineProperty(textarea, 'scrollHeight', { get: () => measuredHeight });
			ResizeObserverHarness.emit(textarea, 500);
			await waitFor(() => expect(textarea.style.height).toBe('100px'));
			measuredHeight = 200;
			ResizeObserverHarness.emit(textarea, 250);
			await waitFor(() => expect(textarea.style.height).toBe('200px'));
			const observer = ResizeObserverHarness.instances[0];
			unmount();
			expect(observer.observed.size).toBe(0);
		} finally {
			restore();
		}
	});

	it('leaves explicitly fixed editor fields unsized', async () => {
		render(Textarea, { value: 'Synthetic model configuration', autoSize: false, class: 'h-40' });
		const textarea = screen.getByRole<HTMLTextAreaElement>('textbox');
		await fireEvent.input(textarea, { target: { value: 'Changed configuration' } });
		expect(textarea.style.height).toBe('');
		expect(textarea.classList.contains('content-sized-textarea')).toBe(false);
	});

	it('releases the measured height when a field switches to fixed sizing', async () => {
		const { rerender } = render(Textarea, { value: 'Synthetic draft' });
		const textarea = screen.getByRole<HTMLTextAreaElement>('textbox');
		Object.defineProperty(textarea, 'scrollHeight', { get: () => 120 });
		await rerender({ value: 'Updated synthetic draft' });
		expect(textarea.style.height).toBe('120px');
		await rerender({ autoSize: false, class: 'h-40' });
		expect(textarea.style.height).toBe('');
	});
});
