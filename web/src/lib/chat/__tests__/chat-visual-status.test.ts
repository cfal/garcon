import { describe, expect, it } from 'vitest';
import { getChatVisualStatus } from '../chat-visual-status';

describe('getChatVisualStatus', () => {
	it('shows idle when a coarse processing update clears a running turn', () => {
		const status = getChatVisualStatus({
			status: 'running',
			isProcessing: false,
			turnState: 'running',
		});

		expect(status.kind).toBe('idle');
		expect(status.label).toBeNull();
	});
});
