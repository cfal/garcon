import { describe, expect, it, vi } from 'vitest';
import { SnippetExpansionController } from '../snippet-expansion-controller.svelte';
import type { ExpandSnippetRequest, ExpandSnippetResponse } from '$shared/snippets';

const request: ExpandSnippetRequest = {
	shortName: 'review',
	arguments: 'the API',
	context: { type: 'project', projectPath: '/repo' },
};

const response: ExpandSnippetResponse = {
	success: true,
	snippetId: 'snippet-1',
	snippetUpdatedAt: '2026-01-01T00:00:00.000Z',
	shortName: 'review',
	contextProjectPath: '/repo',
	expandedText: 'Review the API in /repo',
};

describe('SnippetExpansionController', () => {
	it('tracks a pending expansion and returns the response', async () => {
		let resolve!: (value: ExpandSnippetResponse) => void;
		const expand = vi.fn(() => new Promise<ExpandSnippetResponse>((done) => (resolve = done)));
		const controller = new SnippetExpansionController({ expand });

		const running = controller.run(request);
		expect(controller.pending).toBe(true);
		expect(controller.pendingShortName).toBe('review');
		resolve(response);

		expect(await running).toEqual({ kind: 'expanded', response, generation: 1 });
		expect(controller.pending).toBe(false);
		expect(controller.pendingShortName).toBeNull();
	});

	it('suppresses a duplicate expansion while one is pending', async () => {
		let resolve!: (value: ExpandSnippetResponse) => void;
		const expand = vi.fn(() => new Promise<ExpandSnippetResponse>((done) => (resolve = done)));
		const controller = new SnippetExpansionController({ expand });

		const first = controller.run(request);
		expect(await controller.run(request)).toEqual({ kind: 'cancelled' });
		expect(expand).toHaveBeenCalledTimes(1);
		resolve(response);
		await first;
	});

	it('aborts and ignores a late response after cancellation', async () => {
		let resolve!: (value: ExpandSnippetResponse) => void;
		let signal!: AbortSignal;
		const expand = vi.fn(
			(_request: ExpandSnippetRequest, options?: { signal?: AbortSignal | null }) =>
				new Promise<ExpandSnippetResponse>((done) => {
					resolve = done;
					signal = options?.signal as AbortSignal;
				}),
		);
		const controller = new SnippetExpansionController({ expand });

		const running = controller.run(request);
		controller.cancel();
		expect(signal.aborted).toBe(true);
		expect(controller.pending).toBe(false);
		resolve(response);

		expect(await running).toEqual({ kind: 'cancelled' });
	});

	it('clears pending state and propagates expansion errors', async () => {
		const controller = new SnippetExpansionController({
			expand: vi.fn().mockRejectedValue(new Error('unavailable')),
		});

		await expect(controller.run(request)).rejects.toThrow('unavailable');
		expect(controller.pending).toBe(false);
		expect(controller.pendingShortName).toBeNull();
	});
});
