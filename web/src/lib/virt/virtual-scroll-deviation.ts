import type { VirtualCorrectionProvenance, VirtualScrollActivity } from './virtual-list-types';

export interface VirtualDeviationState {
	readonly value: number;
	readonly pendingSince: number | null;
}

export type VirtualDeviationDecision =
	| { readonly kind: 'settled'; readonly state: VirtualDeviationState }
	| { readonly kind: 'deferred'; readonly state: VirtualDeviationState }
	| {
			readonly kind: 'redeem';
			readonly amount: number;
			readonly state: VirtualDeviationState;
	  };

export const SETTLED_VIRTUAL_DEVIATION: VirtualDeviationState = Object.freeze({
	value: 0,
	pendingSince: null,
});

export function applyVirtualCorrection(input: {
	readonly current: VirtualDeviationState;
	readonly correction: number;
	readonly activity: VirtualScrollActivity;
	readonly provenance: VirtualCorrectionProvenance;
	readonly inPhysicalBounds: boolean;
	readonly now: number;
}): VirtualDeviationDecision {
	const value = input.current.value + input.correction;
	if (Math.abs(value) < Number.EPSILON) {
		return { kind: 'settled', state: SETTLED_VIRTUAL_DEVIATION };
	}

	const pending: VirtualDeviationState = {
		value,
		pendingSince: input.current.pendingSince ?? input.now,
	};
	if (
		(input.provenance !== 'navigation' && input.activity !== 'idle') ||
		(!input.inPhysicalBounds && input.provenance !== 'navigation')
	) {
		return { kind: 'deferred', state: pending };
	}

	return {
		kind: 'redeem',
		amount: value,
		state: SETTLED_VIRTUAL_DEVIATION,
	};
}
