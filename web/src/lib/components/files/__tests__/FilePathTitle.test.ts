import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { tick } from 'svelte';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
	installResizeObserverHarness,
	ResizeObserverHarness,
} from '$lib/components/shared/__tests__/resize-observer-harness.js';
import FilePathTitle from '../FilePathTitle.svelte';

const { copyToClipboard } = vi.hoisted(() => ({ copyToClipboard: vi.fn(async () => true) }));
vi.mock('$lib/utils/clipboard', () => ({ copyToClipboard }));

let restoreResizeObserver: () => void;
beforeAll(() => {
	restoreResizeObserver = installResizeObserverHarness();
});
afterEach(cleanup);
afterAll(() => restoreResizeObserver());

describe('FilePathTitle', () => {
	it('switches between full path and basename as space changes while always copying the full path', async () => {
		const path = '/workspace/project/src/file.ts';
		const { container, rerender } = render(FilePathTitle, {
			path,
			fileName: 'file.ts',
			dirty: false,
		});
		await tick();
		const root = container.querySelector<HTMLElement>('[data-file-path-title]')!;
		const measure = container.querySelector<HTMLElement>('[data-file-path-title-measure]')!;
		let availableWidth = 400;
		let fullWidth = 300;
		Object.defineProperty(root, 'clientWidth', { get: () => Math.round(availableWidth) });
		Object.defineProperty(measure, 'offsetWidth', { get: () => Math.round(fullWidth) });
		ResizeObserverHarness.emit(measure, fullWidth);

		for (const [width, expectedTitle] of [
			[400, path],
			[299, 'file.ts'],
			[300, path],
		] as const) {
			availableWidth = width;
			ResizeObserverHarness.emit(root, width);
			await tick();
			expect(screen.getByRole('heading', { level: 2 }).textContent).toBe(expectedTitle);
			expect(screen.getByRole('heading', { level: 2 }).title).toBe(path);
		}
		fullWidth = 300.421875;
		ResizeObserverHarness.emit(measure, fullWidth);
		await tick();
		expect(screen.getByRole('heading', { level: 2 }).textContent).toBe('file.ts');
		availableWidth = fullWidth;
		ResizeObserverHarness.emit(root, availableWidth);
		await tick();
		expect(screen.getByRole('heading', { level: 2 }).textContent).toBe(path);

		await rerender({ path, fileName: 'file.ts', dirty: true });
		const controls = screen.getByRole('button', { name: 'Copy file path' }).parentElement!;
		ResizeObserverHarness.emit(controls, 41.421875);
		fullWidth = 320.421875;
		ResizeObserverHarness.emit(measure, fullWidth);
		availableWidth = 320;
		ResizeObserverHarness.emit(root, availableWidth);
		await tick();
		expect((measure.lastElementChild as HTMLElement).style.width).toBe('41.421875px');
		expect(screen.getByRole('heading', { level: 2 }).textContent).toBe('file.ts');
		expect(screen.getByRole('img', { name: 'Unsaved' })).toBeTruthy();
		expect(root.classList).toContain('text-xs');
		expect(container.querySelector('p')).toBeNull();
		await fireEvent.click(screen.getByRole('button', { name: 'Copy file path' }));
		await waitFor(() => expect(copyToClipboard).toHaveBeenCalledWith(path, undefined));
	});
});
