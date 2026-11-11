import { describe, expect, it, vi } from 'vitest';
import {
	MERMAID_OUTPUT_LIMIT,
	MERMAID_SOURCE_LIMIT,
	MermaidRenderQueue,
} from '../mermaid-render-queue';

function deferred() {
	let resolve!: (svg: string) => void;
	const promise = new Promise<string>((complete) => {
		resolve = complete;
	});
	return { promise, resolve };
}

describe('Mermaid render admission', () => {
	it('drops cancelled queued revisions without rendering them', async () => {
		const active = deferred();
		const render = vi
			.fn<ConstructorParameters<typeof MermaidRenderQueue>[0]>(async () => '<svg/>')
			.mockReturnValueOnce(active.promise);
		const queue = new MermaidRenderQueue(render);
		const first = queue.render('first', 'standard-light');
		const controller = new AbortController();
		const stale = queue.render('stale', 'standard-light', controller.signal);
		const cancelled = expect(stale).rejects.toMatchObject({ name: 'AbortError' });
		controller.abort();
		const latest = queue.render('latest', 'standard-dark');
		active.resolve('<svg/>');
		await Promise.all([first, latest, cancelled]);
		expect(render.mock.calls.map((call) => call[0])).toEqual(['first', 'latest']);
	});

	it('retains shared work when just one consumer cancels and removes listeners', async () => {
		const active = deferred();
		const render = vi.fn<ConstructorParameters<typeof MermaidRenderQueue>[0]>(() => active.promise);
		const queue = new MermaidRenderQueue(render);
		const controller = new AbortController();
		const remove = vi.spyOn(controller.signal, 'removeEventListener');
		const first = queue.render('shared', 'standard-light', controller.signal);
		const second = queue.render('shared', 'standard-light');
		const cancelled = expect(first).rejects.toMatchObject({ name: 'AbortError' });
		controller.abort();
		active.resolve('<svg/>');
		await cancelled;
		await expect(second).resolves.toBe('<svg/>');
		await queue.render('shared', 'standard-light');
		expect(render).toHaveBeenCalledOnce();
		expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
	});

	it('does not cache orphaned active work or remove its replacement', async () => {
		const active = deferred();
		const render = vi
			.fn<ConstructorParameters<typeof MermaidRenderQueue>[0]>(async () => '<svg>new</svg>')
			.mockReturnValueOnce(active.promise);
		const queue = new MermaidRenderQueue(render);
		const controller = new AbortController();
		const first = queue.render('same', 'standard-light', controller.signal);
		const cancelled = expect(first).rejects.toMatchObject({ name: 'AbortError' });
		controller.abort();
		const next = queue.render('same', 'standard-light');
		expect(render).toHaveBeenCalledOnce();
		active.resolve('<svg>old</svg>');
		await cancelled;
		await expect(next).resolves.toBe('<svg>new</svg>');
		await expect(queue.render('same', 'standard-light')).resolves.toBe('<svg>new</svg>');
		expect(render).toHaveBeenCalledTimes(2);
	});

	it('serializes a large live document and removes its cancelled queued revisions', async () => {
		const active = deferred();
		const render = vi
			.fn<ConstructorParameters<typeof MermaidRenderQueue>[0]>(async () => '<svg/>')
			.mockReturnValueOnce(active.promise);
		const queue = new MermaidRenderQueue(render);
		const first = queue.render('active', 'standard-light');
		const controllers = Array.from({ length: 40 }, () => new AbortController());
		const pending = controllers.map((controller, index) =>
			queue.render(`pending-${index}`, 'standard-light', controller.signal),
		);
		const outcomes = Promise.allSettled(pending);
		const overflow = queue.render('overflow', 'standard-light');
		for (const controller of controllers.slice(0, 20)) controller.abort();
		const latest = queue.render('latest', 'standard-light');
		expect(render).toHaveBeenCalledOnce();
		active.resolve('<svg/>');
		await expect(Promise.all([first, latest, overflow])).resolves.toEqual([
			'<svg/>',
			'<svg/>',
			'<svg/>',
		]);
		expect(await outcomes).toEqual([
			...Array.from({ length: 20 }, () => ({
				status: 'rejected',
				reason: expect.objectContaining({ name: 'AbortError' }),
			})),
			...Array.from({ length: 20 }, () => ({ status: 'fulfilled', value: '<svg/>' })),
		]);
		expect(render.mock.calls.map(([source]) => source)).toEqual([
			'active',
			...Array.from({ length: 20 }, (_, index) => `pending-${index + 20}`),
			'overflow',
			'latest',
		]);
	});

	it('rejects excessive source/output and continues after render failures', async () => {
		const render = vi.fn<ConstructorParameters<typeof MermaidRenderQueue>[0]>(async () => '<svg/>');
		const queue = new MermaidRenderQueue(render);
		await expect(
			queue.render('x'.repeat(MERMAID_SOURCE_LIMIT + 1), 'standard-light'),
		).rejects.toThrow('too large');
		expect(render).not.toHaveBeenCalled();
		render.mockResolvedValueOnce('x'.repeat(MERMAID_OUTPUT_LIMIT + 1));
		await expect(queue.render('large', 'standard-light')).rejects.toThrow('too large');
		render.mockRejectedValueOnce(new Error('invalid syntax'));
		await expect(queue.render('invalid', 'standard-light')).rejects.toThrow('invalid syntax');
		await expect(queue.render('large', 'standard-light')).resolves.toBe('<svg/>');
	});

	it('evicts cached source/output by aggregate bytes in access order', async () => {
		const render = vi.fn<ConstructorParameters<typeof MermaidRenderQueue>[0]>(async () =>
			'x'.repeat(MERMAID_OUTPUT_LIMIT),
		);
		const queue = new MermaidRenderQueue(render);
		for (let index = 0; index < 4; index += 1)
			await queue.render(`source-${index}`, 'standard-light');
		await queue.render('source-0', 'standard-light');
		await queue.render('source-4', 'standard-light');
		await queue.render('source-0', 'standard-light');
		expect(render).toHaveBeenCalledTimes(5);
		await queue.render('source-1', 'standard-light');
		expect(render).toHaveBeenCalledTimes(6);
	});
});
