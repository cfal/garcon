import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { processingPulsePhaseMs } from '../processing-pulse.js';

const appCss = readFileSync(new URL('../../../../app.css', import.meta.url), 'utf8');

describe('processing pulse', () => {
	it('uses a shared phase duration and steps the working indicators', () => {
		expect(appCss).toContain('--processing-pulse-duration: 2.4s;');
		expect(appCss).toContain('--processing-motion-timing: steps(12, end);');
		expect(appCss).toMatch(
			/\.chat-processing-spinner\s*\{[^}]*animation-timing-function: var\(--processing-motion-timing\)/,
		);
	});

	it('keeps the composer static unless motion is allowed', () => {
		const staticRule = appCss.match(/\.composer-thinking-active\s*\{([^}]*)\}/)?.[1];
		const animatedRule = appCss.match(
			/@media \(prefers-reduced-motion: no-preference\)\s*\{\s*\.composer-thinking-active:not\(\.composer-reduce-motion\)\s*\{([^}]*)\}/,
		)?.[1];

		expect(appCss).toMatch(
			/@keyframes composer-thinking-border-pulse\s*\{[\s\S]*?border-color: hsl\(var\(--border\)\);[\s\S]*?border-color: hsl\(var\(--composer-thinking-pulse-emphasis\)\);[\s\S]*?\}/,
		);
		expect(staticRule).toContain('--composer-thinking-animation: none;');
		expect(staticRule).toContain('linear-gradient(hsl(var(--card)) 0 0) padding-box,');
		expect(staticRule).toContain('to bottom,');
		expect(staticRule).toContain('hsl(var(--composer-thinking-static-start)) 0%,');
		expect(staticRule).toContain('hsl(var(--border)) 100%');
		expect(staticRule).toContain(
			'--composer-thinking-status-border: hsl(var(--composer-thinking-static-start));',
		);
		expect(animatedRule).toMatch(
			/--composer-thinking-animation: composer-thinking-border-pulse var\(--processing-pulse-duration\)\s+var\(--processing-motion-timing\) infinite;/,
		);
		expect(animatedRule).not.toContain('composer-thinking-static-start');
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
