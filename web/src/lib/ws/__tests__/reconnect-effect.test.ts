import { describe, expect, it, vi } from 'vitest';
import { mountReconnectEffectHarness } from './reconnect-effect-harness.svelte.js';

describe('createWsReconnectEffect', () => {
	it('runs only when lastConnectedAt changes despite connectionStatus object replacements', () => {
		const cleanup = vi.fn();
		const onConnect = vi.fn(() => cleanup);
		const harness = mountReconnectEffectHarness(onConnect);

		expect(onConnect).not.toHaveBeenCalled();

		harness.setStatus({ lastConnectedAt: 1000 });
		expect(onConnect).toHaveBeenCalledTimes(1);
		expect(onConnect).toHaveBeenLastCalledWith(1000);
		expect(cleanup).not.toHaveBeenCalled();

		// Replacing the status object on stability reset, disconnect, or retry preserves lastConnectedAt.
		harness.setStatus({ lastConnectedAt: 1000 });
		harness.setStatus({ lastConnectedAt: 1000 });
		expect(onConnect).toHaveBeenCalledTimes(1);
		expect(cleanup).not.toHaveBeenCalled();

		harness.setStatus({ lastConnectedAt: 2000 });
		expect(cleanup).toHaveBeenCalledTimes(1);
		expect(onConnect).toHaveBeenCalledTimes(2);
		expect(onConnect).toHaveBeenLastCalledWith(2000);

		harness.destroy();
		expect(cleanup).toHaveBeenCalledTimes(2);
	});
});
