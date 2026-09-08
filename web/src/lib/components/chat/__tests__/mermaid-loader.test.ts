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
		const { renderMermaid } = await import('../mermaid-loader.js');
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
		const { renderMermaid } = await import('../mermaid-loader.js');

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
		const { renderMermaid } = await import('../mermaid-loader.js');
		for (const themeId of [
			'standard-light',
			'standard-dark',
			'colorblind-light',
			'colorblind-dark',
		] as const) {
			await renderMermaid(`gantt\ntitle ${themeId}`, themeId);
		}

		expect(mermaid.initialize).toHaveBeenCalledTimes(4);
		for (const [config] of mermaid.initialize.mock.calls) {
			expect(config).toMatchObject({
				startOnLoad: false,
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
});
