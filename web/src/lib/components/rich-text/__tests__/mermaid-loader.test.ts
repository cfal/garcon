import { beforeEach, describe, expect, it, vi } from 'vitest';

const mermaid = vi.hoisted(() => ({
	initialize: vi.fn(),
	render: vi.fn(),
}));

vi.mock('mermaid', () => ({ default: mermaid }));

describe('mermaid-loader', () => {
	beforeEach(() => {
		vi.resetModules();
		mermaid.initialize.mockReset();
		mermaid.render.mockReset();
		mermaid.render.mockResolvedValue({ svg: '<svg></svg>' });
	});

	it('keys completed and in-flight renders by source and renderer theme', async () => {
		const { renderMermaid } = await import('$lib/components/rich-text/mermaid-loader.js');
		const source = 'flowchart LR\nA --> B';

		await Promise.all([
			renderMermaid(source, 'standard-light'),
			renderMermaid(source, 'standard-light'),
		]);
		expect(mermaid.render).toHaveBeenCalledOnce();

		await renderMermaid(source, 'standard-light');
		expect(mermaid.render).toHaveBeenCalledOnce();

		await renderMermaid(source, 'colorblind-light');
		expect(mermaid.render).toHaveBeenCalledTimes(2);
		expect(mermaid.initialize).toHaveBeenCalledTimes(2);
	});

	it('serializes initialize and render when renderer themes change', async () => {
		let resolveFirst!: (value: { svg: string }) => void;
		mermaid.render
			.mockImplementationOnce(
				() => new Promise<{ svg: string }>((resolve) => (resolveFirst = resolve)),
			)
			.mockResolvedValueOnce({ svg: '<svg data-theme="dark"></svg>' });
		const { renderMermaid } = await import('$lib/components/rich-text/mermaid-loader.js');

		const first = renderMermaid('flowchart LR\nA --> B', 'standard-light');
		await vi.waitFor(() => expect(mermaid.render).toHaveBeenCalledOnce());
		const second = renderMermaid('gantt\ntitle Example', 'standard-dark');
		await Promise.resolve();

		expect(mermaid.initialize).toHaveBeenCalledOnce();
		expect(mermaid.render).toHaveBeenCalledOnce();
		resolveFirst({ svg: '<svg data-theme="light"></svg>' });
		await first;
		await second;

		expect(mermaid.initialize).toHaveBeenCalledTimes(2);
		expect(mermaid.render).toHaveBeenCalledTimes(2);
	});

	it('supplies explicit contrast-corrected configuration for every renderer theme', async () => {
		const { renderMermaid } = await import('$lib/components/rich-text/mermaid-loader.js');
		for (const themeId of [
			'standard-light',
			'standard-dark',
			'colorblind-light',
			'colorblind-dark',
			'owl-light',
			'owl-dark',
			'neko-light',
			'neko-dark',
			'semantic-light',
			'semantic-dark',
		] as const) {
			await renderMermaid(`gantt\ntitle ${themeId}`, themeId);
		}

		expect(mermaid.initialize).toHaveBeenCalledTimes(10);
		for (const [config] of mermaid.initialize.mock.calls) {
			expect(config).toMatchObject({
				startOnLoad: false,
				fontFamily:
					'-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
				securityLevel: 'strict',
				suppressErrorRendering: true,
				themeVariables: {
					primaryTextColor: expect.any(String),
					textColor: expect.any(String),
					taskTextColor: expect.any(String),
					taskBkgColor: expect.any(String),
				},
			});
		}
	});

	it('skips abandoned queued work without cancelling another consumer', async () => {
		const { renderMermaid } = await import('../mermaid-loader');
		let release!: (value: { svg: string }) => void;
		mermaid.render.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
		const first = renderMermaid('first', 'standard-light');
		await vi.waitFor(() => expect(mermaid.render).toHaveBeenCalledOnce());
		const abandoned = new AbortController();
		const cancelled = renderMermaid('abandoned', 'standard-dark', abandoned.signal);
		const rejection = expect(cancelled).rejects.toMatchObject({ name: 'AbortError' });
		abandoned.abort();
		await rejection;
		const peer = new AbortController();
		const cancelledPeer = renderMermaid('shared', 'standard-dark', peer.signal);
		const peerRejection = expect(cancelledPeer).rejects.toMatchObject({ name: 'AbortError' });
		const retained = renderMermaid('shared', 'standard-dark');
		peer.abort();
		await peerRejection;
		release({ svg: '<svg />' });
		await first;
		await retained;
		expect(mermaid.render.mock.calls.map((call) => call[1])).toEqual(['first', 'shared']);
	});

	it('evicts the least recently used entry at the entry-count limit', async () => {
		const { renderMermaid } = await import('../mermaid-loader');
		for (let index = 0; index < 64; index++) await renderMermaid(`item-${index}`, 'standard-light');
		await renderMermaid('item-0', 'standard-light');
		await renderMermaid('new', 'standard-light');
		await renderMermaid('item-0', 'standard-light');
		expect(mermaid.render).toHaveBeenCalledTimes(65);
		await renderMermaid('item-1', 'standard-light');
		expect(mermaid.render).toHaveBeenCalledTimes(66);
	});

	it('evicts by aggregate SVG bytes before reaching the entry-count limit', async () => {
		const { renderMermaid } = await import('../mermaid-loader');
		mermaid.render.mockResolvedValue({ svg: 'x'.repeat(750_000) });
		await renderMermaid('first', 'standard-light');
		await renderMermaid('second', 'standard-light');
		await renderMermaid('first', 'standard-light');
		await renderMermaid('third', 'standard-light');
		await renderMermaid('first', 'standard-light');
		await renderMermaid('third', 'standard-light');
		expect(mermaid.render).toHaveBeenCalledTimes(3);
		await renderMermaid('second', 'standard-light');
		expect(mermaid.render).toHaveBeenCalledTimes(4);
	});

	it('returns oversized SVGs without retaining them or evicting useful entries', async () => {
		const { renderMermaid } = await import('../mermaid-loader');
		await renderMermaid('retained', 'standard-light');
		mermaid.render.mockResolvedValue({ svg: 'x'.repeat(3 * 1024 * 1024) });
		expect(await renderMermaid('oversized', 'standard-light')).toHaveLength(3 * 1024 * 1024);
		await renderMermaid('oversized', 'standard-light');
		await expect(renderMermaid('retained', 'standard-light')).resolves.toBe('<svg></svg>');
		expect(mermaid.render).toHaveBeenCalledTimes(3);
	});

	it.each([0, 1, 2, 3, 4, 5, 6, 7, 8])('accepts fresh demand %i microtasks after cancellation', async (turns) => {
		const { renderMermaid } = await import('../mermaid-loader');
		let release!: (value: { svg: string }) => void;
		mermaid.render.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
		const abort = new AbortController();
		const cancelled = renderMermaid('reattached', 'standard-light', abort.signal);
		const rejection = expect(cancelled).rejects.toMatchObject({ name: 'AbortError' });
		abort.abort();
		for (let index = 0; index < turns; index++) await Promise.resolve();
		const fresh = renderMermaid('reattached', 'standard-light');
		const completion = expect(fresh).resolves.toBe('<svg></svg>');
		await rejection;
		await vi.waitFor(() => expect(mermaid.render).toHaveBeenCalledOnce());
		const peer = renderMermaid('reattached', 'standard-light');
		release({ svg: '<svg></svg>' });
		await completion;
		await expect(peer).resolves.toBe('<svg></svg>');
		expect(mermaid.render).toHaveBeenCalledOnce();
	});

	it('releases failed jobs for retry', async () => {
		const { renderMermaid } = await import('../mermaid-loader');
		mermaid.render.mockRejectedValueOnce(new Error('invalid'));
		await expect(renderMermaid('retry', 'standard-light')).rejects.toThrow('invalid');
		await expect(renderMermaid('retry', 'standard-light')).resolves.toBe('<svg></svg>');
	});
});
