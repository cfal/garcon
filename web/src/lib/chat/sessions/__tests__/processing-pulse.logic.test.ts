import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { processingPulsePhaseMs } from '../processing-pulse.js';

describe('processing pulse', () => {
	it('uses one cadence for composer, status, sidebar, and workspace animations', () => {
		const appCss = readFileSync(new URL('../../../../app.css', import.meta.url), 'utf8');

		expect(appCss).toContain('--processing-pulse-duration: 2.4s;');
		expect(appCss).toMatch(
			/composer-thinking-border-pulse var\(--processing-pulse-duration\)\s+ease-in-out infinite/,
		);
		expect(appCss).toMatch(
			/sidebar-processing-pulse var\(--processing-pulse-duration\) ease-in-out infinite/,
		);
		expect(appCss).toMatch(
			/@keyframes sidebar-processing-pulse\s*\{\s*0%,\s*100%\s*\{\s*opacity: 0\.4;\s*\}\s*50%\s*\{\s*opacity: 1;\s*\}/,
		);
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
