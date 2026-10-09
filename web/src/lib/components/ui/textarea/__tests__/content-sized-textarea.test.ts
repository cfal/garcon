import { afterEach, describe, expect, it, vi } from 'vitest';
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

	it('measures from the resting rows so a long-form field keeps its floor', async () => {
		const { rerender } = render(Textarea, { value: '', rows: 3 });
		const textarea = screen.getByRole<HTMLTextAreaElement>('textbox');
		const heightsWhileMeasuring = new Set<string>();
		Object.defineProperty(textarea, 'scrollHeight', {
			get: () => {
				heightsWhileMeasuring.add(textarea.style.height);
				return 76;
			},
		});
		await rerender({ value: 'Synthetic draft', rows: 3 });
		expect(textarea.getAttribute('rows')).toBe('3');
		// An automatic height lets the browser apply the rows; a collapsed one would ignore them.
		expect([...heightsWhileMeasuring]).toEqual(['auto']);
		expect(textarea.style.height).toBe('76px');
	});

	it('measures without a scrollbar or a shrinking layout and restores the field afterwards', async () => {
		const { rerender } = render(Textarea, { value: '' });
		const textarea = screen.getByRole<HTMLTextAreaElement>('textbox');
		textarea.style.marginBottom = '4px';
		textarea.style.width = '320px';
		Object.defineProperty(textarea, 'offsetHeight', { get: () => 120 });
		let whileMeasuring = { overflowY: '', marginBottom: '', width: '' };
		Object.defineProperty(textarea, 'scrollHeight', {
			get: () => {
				whileMeasuring = {
					overflowY: textarea.style.overflowY,
					marginBottom: textarea.style.marginBottom,
					width: textarea.style.width,
				};
				return 96;
			},
		});
		await rerender({ value: 'Synthetic multiline draft' });
		expect(whileMeasuring.overflowY).toBe('hidden');
		expect(whileMeasuring.width).toBe('320px');
		// The previous height stays reserved so nothing around the field moves up meanwhile.
		expect(whileMeasuring.marginBottom).toContain('120px');
		expect(textarea.style.overflowY).toBe('');
		expect(textarea.style.marginBottom).toBe('4px');
		expect(textarea.style.width).toBe('320px');
		expect(textarea.style.height).toBe('96px');
	});

	it('keeps its height while it has no layout box', async () => {
		const { rerender } = render(Textarea, { value: 'Synthetic draft' });
		const textarea = screen.getByRole<HTMLTextAreaElement>('textbox');
		Object.defineProperty(textarea, 'scrollHeight', { configurable: true, get: () => 96 });
		await rerender({ value: 'Synthetic longer draft' });
		expect(textarea.style.height).toBe('96px');
		Object.defineProperty(textarea, 'scrollHeight', { get: () => 0 });
		vi.spyOn(textarea, 'getClientRects').mockReturnValue(Object.assign([], { item: () => null }));
		await rerender({ value: 'Synthetic draft changed while hidden' });
		expect(textarea.style.height).toBe('96px');
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
