import { describe, expect, it } from 'vitest';
import {
	applyVirtualCorrection,
	isVirtualDeviationStale,
	preserveVirtualDeviation,
	resetVirtualDeviation,
	SETTLED_VIRTUAL_DEVIATION,
} from '../virtual-scroll-deviation';

const redeemable = {
	inPhysicalBounds: true,
	canRedeemExactly: true,
	now: 100,
} as const;

describe('virtual scroll deviation', () => {
	it.each(['measurement', 'follow'] as const)(
		'defers %s correction during dragging and coasting',
		(provenance) => {
			for (const activity of ['dragging', 'coasting'] as const) {
				expect(
					applyVirtualCorrection({
						current: SETTLED_VIRTUAL_DEVIATION,
						correction: 40,
						activity,
						provenance,
						...redeemable,
					}),
				).toEqual({ kind: 'deferred', state: { value: 40, pendingSince: 100 } });
			}
		},
	);

	it.each(['measurement', 'follow', 'navigation'] as const)(
		'redeems idle %s correction',
		(provenance) => {
			expect(
				applyVirtualCorrection({
					current: { value: 10, pendingSince: 50 },
					correction: 5,
					activity: 'idle',
					provenance,
					...redeemable,
				}),
			).toEqual({
				kind: 'redeem',
				amount: 15,
				exact: true,
				state: SETTLED_VIRTUAL_DEVIATION,
			});
		},
	);

	it('never defers navigation provenance', () => {
		expect(
			applyVirtualCorrection({
				current: SETTLED_VIRTUAL_DEVIATION,
				correction: 20,
				activity: 'coasting',
				provenance: 'navigation',
				inPhysicalBounds: false,
				canRedeemExactly: false,
				now: 100,
			}),
		).toMatchObject({ kind: 'redeem', amount: 20, exact: false });
	});

	it('accumulates corrections and retains the original pending time', () => {
		expect(
			applyVirtualCorrection({
				current: { value: 40, pendingSince: 20 },
				correction: -15,
				activity: 'dragging',
				provenance: 'measurement',
				...redeemable,
			}),
		).toEqual({ kind: 'deferred', state: { value: 25, pendingSince: 20 } });
	});

	it('reports an inexact negative top-boundary redemption', () => {
		expect(
			applyVirtualCorrection({
				current: { value: -30, pendingSince: 20 },
				correction: 0,
				activity: 'idle',
				provenance: 'measurement',
				inPhysicalBounds: true,
				canRedeemExactly: false,
				now: 100,
			}),
		).toMatchObject({ kind: 'redeem', amount: -30, exact: false });
	});

	it('preserves cancellation, resets surface state, and reports liveness', () => {
		const pending = { value: 12, pendingSince: 100 };
		expect(preserveVirtualDeviation(pending)).toBe(pending);
		expect(resetVirtualDeviation()).toBe(SETTLED_VIRTUAL_DEVIATION);
		expect(isVirtualDeviationStale(pending, 1_099)).toBe(false);
		expect(isVirtualDeviationStale(pending, 1_100)).toBe(true);
	});
});
