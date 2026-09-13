import { describe, expect, it, vi } from 'vitest';
import { FileIdentityTeardownQueue } from '../file-identity-teardown-queue.js';

describe('FileIdentityTeardownQueue', () => {
	it('continues a queued teardown after an earlier teardown fails', async () => {
		const queue = new FileIdentityTeardownQueue();
		const first = queue.run('file', () => {
			throw new Error('cleanup failed');
		});
		const secondTeardown = vi.fn();
		const second = queue.run('file', secondTeardown);

		await expect(first).rejects.toThrow('cleanup failed');
		await expect(second).resolves.toBeUndefined();
		expect(secondTeardown).toHaveBeenCalledOnce();
	});
});
