import { describe, expect, it, vi } from 'vitest';
import type { RefinePromptResponse } from '$shared/prompt-refinement';
import { PromptRefinementController } from '../prompt-refinement-controller.svelte';

const response: RefinePromptResponse = {
	success: true,
	refinedPrompt: 'Refined request.',
};

describe('PromptRefinementController', () => {
	it('tracks one request and returns its generation', async () => {
		let resolve!: (value: RefinePromptResponse) => void;
		const refine = vi.fn(() => new Promise<RefinePromptResponse>((done) => (resolve = done)));
		const controller = new PromptRefinementController({ refine });

		const running = controller.run('draft');
		expect(controller.pending).toBe(true);
		expect(await controller.run('duplicate')).toEqual({ kind: 'cancelled' });
		expect(refine).toHaveBeenCalledTimes(1);
		resolve(response);

		expect(await running).toEqual({ kind: 'refined', response, generation: 1 });
		expect(controller.pending).toBe(false);
	});

	it('cancels immediately and ignores late completion or rejection', async () => {
		let resolve!: (value: RefinePromptResponse) => void;
		let signal!: AbortSignal;
		const refine = vi.fn((_request, options) => {
			signal = options.signal as AbortSignal;
			return new Promise<RefinePromptResponse>((done) => (resolve = done));
		});
		const controller = new PromptRefinementController({ refine });

		const running = controller.run('draft');
		controller.cancel();
		expect(controller.pending).toBe(false);
		expect(signal.aborted).toBe(true);
		resolve(response);
		expect(await running).toEqual({ kind: 'cancelled' });

		const rejecting = new PromptRefinementController({
			refine: vi.fn((_request, options) =>
				new Promise<RefinePromptResponse>((_resolve, reject) => {
					options.signal?.addEventListener(
						'abort',
						() => reject(new DOMException('aborted', 'AbortError')),
						{ once: true },
					);
				})),
		});
		const cancelledRejection = rejecting.run('draft');
		rejecting.cancel();
		await expect(cancelledRejection).resolves.toEqual({ kind: 'cancelled' });
	});

	it('does not let an earlier request settle a later generation', async () => {
		const resolvers: Array<(value: RefinePromptResponse) => void> = [];
		const refine = vi.fn(
			() => new Promise<RefinePromptResponse>((resolve) => resolvers.push(resolve)),
		);
		const controller = new PromptRefinementController({ refine });

		const first = controller.run('first');
		controller.cancel();
		const second = controller.run('second');
		resolvers[0](response);
		expect(await first).toEqual({ kind: 'cancelled' });
		expect(controller.pending).toBe(true);

		const laterResponse = { ...response, refinedPrompt: 'Second result.' };
		resolvers[1](laterResponse);
		expect(await second).toEqual({
			kind: 'refined',
			response: laterResponse,
			generation: 3,
		});
		expect(controller.pending).toBe(false);
	});

	it('clears pending state and propagates current failures', async () => {
		const failure = new Error('unavailable');
		const controller = new PromptRefinementController({
			refine: vi.fn().mockRejectedValue(failure),
		});

		await expect(controller.run('draft')).rejects.toBe(failure);
		expect(controller.pending).toBe(false);
	});
});
