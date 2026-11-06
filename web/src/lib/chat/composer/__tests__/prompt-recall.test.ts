import { describe, expect, it, vi } from 'vitest';
import { PromptRecallController, type PromptRecallSource, type RecallPrompt } from '../prompt-recall';

function source(count = 2) {
	return {
		list: vi.fn(async (_signal: AbortSignal) => Array.from({ length: count }, (_, index) => ({ ordinal: count - index, watermark: count }))),
		load: vi.fn(async ({ ordinal }: RecallPrompt, _signal: AbortSignal): Promise<string | null> => `Prompt ${ordinal}`),
	} satisfies PromptRecallSource;
}

describe('prompt recall', () => {
	it('captures at most 100 references and fetches only the selected prompt', async () => {
		const recall = new PromptRecallController(), history = source(110);
		expect(recall.canNavigate('ArrowUp', 'chat:view', '')).toBe(true);
		for (let index = 0; index < 101; index++) await recall.navigate('ArrowUp', 'chat:view', history);
		expect(history.list).toHaveBeenCalledTimes(1);
		expect(history.load).toHaveBeenLastCalledWith({ ordinal: 11, watermark: 110 }, expect.any(AbortSignal));
	});

	it('snapshots references while browsing and returns to an empty draft', async () => {
		const recall = new PromptRecallController(), history = source();
		expect(recall.canNavigate('ArrowDown', 'chat:view', '')).toBe(false);
		expect(recall.canNavigate('ArrowUp', 'chat:view', '')).toBe(true);
		expect(await recall.navigate('ArrowUp', 'chat:view', history)).toBe('Prompt 2');
		expect(recall.canNavigate('ArrowUp', 'chat:view', 'Prompt 2')).toBe(true);
		expect(await recall.navigate('ArrowUp', 'chat:view', history)).toBe('Prompt 1');
		expect(await recall.navigate('ArrowUp', 'chat:view', history)).toBe('Prompt 1');
		expect(await recall.navigate('ArrowDown', 'chat:view', history)).toBe('Prompt 2');
		expect(await recall.navigate('ArrowDown', 'chat:view', history)).toBe('');
		expect(history.list).toHaveBeenCalledTimes(1);
	});

	it('preserves drafts and resets on chat or view changes', async () => {
		const recall = new PromptRecallController(), history = source();
		expect(recall.canNavigate('ArrowUp', 'a:view', 'draft')).toBe(false);
		expect(recall.canNavigate('ArrowUp', 'a:view', '')).toBe(true);
		await recall.navigate('ArrowUp', 'a:view', history);
		expect(recall.canNavigate('ArrowUp', 'a:replacement', 'Prompt 2')).toBe(false);
		expect(recall.canNavigate('ArrowUp', 'b:view', '')).toBe(true);
		expect(await recall.navigate('ArrowUp', 'b:view', source(1))).toBe('Prompt 1');
		recall.reset();
		expect(recall.canNavigate('ArrowUp', null, '')).toBe(false);
	});

	it('rejects late body completion after reset', async () => {
		const recall = new PromptRecallController(), pending = Promise.withResolvers<string>();
		const history = source();
		history.load.mockImplementation(() => pending.promise);
		expect(recall.canNavigate('ArrowUp', 'chat:view', '')).toBe(true);
		const reading = recall.navigate('ArrowUp', 'chat:view', history);
		await Promise.resolve();
		recall.reset();
		pending.resolve('stale text');
		expect(await reading).toBeNull();
		expect(history.load.mock.calls[0][1].aborted).toBe(true);
	});

	it('keeps selection retryable after a failed body read', async () => {
		const recall = new PromptRecallController(), history = source();
		history.load.mockRejectedValueOnce(new Error('offline'));
		expect(recall.canNavigate('ArrowUp', 'chat:view', '')).toBe(true);
		await expect(recall.navigate('ArrowUp', 'chat:view', history)).rejects.toThrow('offline');
		expect(await recall.navigate('ArrowUp', 'chat:view', history)).toBe('Prompt 2');
	});

	it('does not advance the recall index while the selected body is preparing', async () => {
		const recall = new PromptRecallController(), history = source();
		history.load.mockResolvedValueOnce(null);
		expect(await recall.navigate('ArrowUp', 'chat:view', history)).toBeNull();
		expect(await recall.navigate('ArrowUp', 'chat:view', history)).toBe('Prompt 2');
		expect(history.load.mock.calls.map(([prompt]) => prompt)).toEqual([
			{ ordinal: 2, watermark: 2 }, { ordinal: 2, watermark: 2 },
		]);
	});
});
