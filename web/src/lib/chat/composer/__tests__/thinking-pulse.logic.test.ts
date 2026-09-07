import { describe, expect, it } from 'vitest';
import { thinkingPulsePhaseMs } from '../thinking-pulse.js';

describe('thinkingPulsePhaseMs', () => {
	it('maps timestamps onto a shared looping phase', () => {
		expect(thinkingPulsePhaseMs(2400, 0)).toBe(0);
		expect(thinkingPulsePhaseMs(2400, 1200)).toBe(1200);
		expect(thinkingPulsePhaseMs(2400, 2400)).toBe(0);
		expect(thinkingPulsePhaseMs(2400, 2500)).toBe(100);
	});

	it('falls back to zero for invalid durations', () => {
		expect(thinkingPulsePhaseMs(0, 500)).toBe(0);
		expect(thinkingPulsePhaseMs(-1, 500)).toBe(0);
		expect(thinkingPulsePhaseMs(Number.NaN, 500)).toBe(0);
	});
});
