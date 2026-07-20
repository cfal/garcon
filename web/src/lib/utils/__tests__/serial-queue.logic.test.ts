import { describe, expect, it } from 'vitest';
import { SerialQueue } from '../serial-queue.js';

describe('SerialQueue', () => {
	it('runs operations in insertion order', async () => {
		const queue = new SerialQueue();
		const events: string[] = [];
		let releaseFirst!: () => void;
		const firstGate = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});

		const first = queue.enqueue(async () => {
			events.push('first-start');
			await firstGate;
			events.push('first-end');
			return 1;
		});
		const second = queue.enqueue(() => {
			events.push('second');
			return 2;
		});

		await Promise.resolve();
		expect(events).toEqual(['first-start']);
		releaseFirst();
		await expect(Promise.all([first, second])).resolves.toEqual([1, 2]);
		expect(events).toEqual(['first-start', 'first-end', 'second']);
	});

	it('continues after an operation rejects', async () => {
		const queue = new SerialQueue();
		const failed = queue.enqueue(() => {
			throw new Error('failed turn');
		});
		const next = queue.enqueue(() => 'continued');

		await expect(failed).rejects.toThrow('failed turn');
		await expect(next).resolves.toBe('continued');
	});
});
