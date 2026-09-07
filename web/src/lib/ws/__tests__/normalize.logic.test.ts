import { afterEach, describe, expect, it, vi } from 'vitest';
import { normalizeEvent } from '../normalize';

describe('normalizeEvent', () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('declines terminal messages without reporting them as unknown', () => {
		const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

		expect(normalizeEvent({
			type: 'terminal-terminated',
			terminalId: 'terminal-1',
		})).toBeNull();
		expect(consoleError).not.toHaveBeenCalled();
	});

	it('reports malformed terminal messages as unknown', () => {
		const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

		expect(normalizeEvent({ type: 'terminal-terminated' })).toBeNull();
		expect(consoleError).toHaveBeenCalledOnce();
	});
});
