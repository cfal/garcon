import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { processingPulsePhaseMs } from '../processing-pulse.js';

describe('processing pulse', () => {
	it('defines the shared pulse duration', () => {
		const appCss = readFileSync(new URL('../../../../app.css', import.meta.url), 'utf8');

		expect(appCss).toContain('--processing-pulse-duration: 2.4s;');
	});

	it('maps timestamps onto a shared looping phase', () => {
		expect(processingPulsePhaseMs(2400, 0)).toBe(0);
		expect(processingPulsePhaseMs(2400, 1200)).toBe(1200);
		expect(processingPulsePhaseMs(2400, 2400)).toBe(0);
		expect(processingPulsePhaseMs(2400, 2500)).toBe(100);
	});

	it('falls back to zero for invalid durations', () => {
		expect(processingPulsePhaseMs(0, 500)).toBe(0);
		expect(processingPulsePhaseMs(-1, 500)).toBe(0);
		expect(processingPulsePhaseMs(Number.NaN, 500)).toBe(0);
	});
});
