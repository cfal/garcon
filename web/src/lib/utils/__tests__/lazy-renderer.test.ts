import { describe, expect, it, vi } from 'vitest';
import { lazyRenderer } from '../lazy-renderer.js';

describe('lazyRenderer', () => {
	it('shares one successful load across callers', async () => {
		const renderer = { name: 'renderer' };
		const load = vi.fn(async () => ({ default: renderer }));
		const getRenderer = lazyRenderer(load);

		await expect(Promise.all([getRenderer(), getRenderer()])).resolves.toEqual([
			renderer,
			renderer,
		]);
		expect(load).toHaveBeenCalledOnce();
		await expect(getRenderer()).resolves.toBe(renderer);
		expect(load).toHaveBeenCalledOnce();
	});

	it('clears a failed load so the next call can retry', async () => {
		const renderer = { name: 'renderer' };
		const load = vi
			.fn<() => Promise<{ default: typeof renderer }>>()
			.mockRejectedValueOnce(new Error('load failed'))
			.mockResolvedValueOnce({ default: renderer });
		const getRenderer = lazyRenderer(load);

		await expect(getRenderer()).rejects.toThrow('load failed');
		await expect(getRenderer()).resolves.toBe(renderer);
		expect(load).toHaveBeenCalledTimes(2);
	});
});
