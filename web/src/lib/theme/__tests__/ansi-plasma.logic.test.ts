import { describe, expect, it } from 'vitest';
import { createPlasmaScene, plasmaCell, plasmaGrid, plasmaValue } from '../ansi-plasma.js';

describe('ASCII screensaver plasma port', () => {
	it('retains the source waves and ASCII density ramp', () => {
		const scene = { phase: [0, 0, 0, 0], speed: 1 } as const;
		expect(plasmaValue(0, 0, 0, scene)).toBe(0.5);
		expect(plasmaCell(0)).toEqual({ glyph: ' ', color: 'rgb(18,22,58)' });
		expect(plasmaCell(0.5)).toEqual({ glyph: '+', color: 'rgb(20,210,176)' });
		expect(plasmaCell(1).glyph).toBe('@');
	});

	it('renders deterministic, visible, changing frames', () => {
		const scene = createPlasmaScene(() => 0.4);
		const frame = (time: number) =>
			Array.from(
				{ length: 480 },
				(_, index) =>
					plasmaCell(
						plasmaValue((index % 40) / 20 - 1, Math.floor(index / 40) / 6 - 1, time, scene),
					).glyph,
			).join('');
		expect(frame(1.25)).toBe(frame(1.25));
		expect(frame(1.25)).not.toBe(frame(2));
		expect(frame(1.25).replaceAll(' ', '').length).toBeGreaterThan(240);
		expect(frame(1.25)).toMatch(/^[ .:\-=+*#%@]+$/);
	});

	it.each([
		[0, 0],
		[320, 568],
		[1440, 900],
		[7680, 4320],
	])('bounds work at %i by %i regardless of device pixel ratio', (width, height) => {
		const { columns, rows } = plasmaGrid(width, height);
		expect(columns).toBeGreaterThanOrEqual(1);
		expect(columns).toBeLessThanOrEqual(120);
		expect(rows).toBeGreaterThanOrEqual(1);
		expect(rows).toBeLessThanOrEqual(45);
	});
});
