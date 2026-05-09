export interface MobileViewportSnapshot {
	visualViewportHeight: number;
	visualViewportOffsetTop: number;
	windowInnerHeight: number;
	baselineAppHeight?: number | null;
	previousAppHeight?: number | null;
	minAppHeight?: number;
	keyboardVisibleThreshold?: number;
}

export interface MobileViewportMetrics {
	appHeight: number;
	viewportOffsetTop: number;
	keyboardHeight: number;
	keyboardVisible: boolean;
}

const DEFAULT_MIN_APP_HEIGHT = 160;
const DEFAULT_KEYBOARD_VISIBLE_THRESHOLD = 80;

function finitePositive(value: number | null | undefined): number | null {
	return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

export function computeMobileViewportMetrics(snapshot: MobileViewportSnapshot): MobileViewportMetrics {
	const minAppHeight = snapshot.minAppHeight ?? DEFAULT_MIN_APP_HEIGHT;
	const keyboardVisibleThreshold = snapshot.keyboardVisibleThreshold ?? DEFAULT_KEYBOARD_VISIBLE_THRESHOLD;
	const baselineAppHeight = finitePositive(snapshot.baselineAppHeight);
	const previousAppHeight = finitePositive(snapshot.previousAppHeight);
	const windowInnerHeight = finitePositive(snapshot.windowInnerHeight);
	const visualViewportHeight = finitePositive(snapshot.visualViewportHeight);
	const visualViewportOffsetTop = finitePositive(snapshot.visualViewportOffsetTop) ?? 0;
	const fallbackHeight = previousAppHeight ?? windowInnerHeight ?? minAppHeight;
	const stableVisualHeight = visualViewportHeight && visualViewportHeight >= minAppHeight
		? visualViewportHeight
		: fallbackHeight;
	const appHeight = Math.round(Math.max(minAppHeight, stableVisualHeight));
	const keyboardReferenceHeight = visualViewportHeight ?? appHeight;
	const keyboardHeight = Math.max(
		0,
		Math.round((windowInnerHeight ?? appHeight) - keyboardReferenceHeight),
		Math.round((baselineAppHeight ?? appHeight) - keyboardReferenceHeight),
		Math.round(visualViewportOffsetTop),
	);

	return {
		appHeight,
		viewportOffsetTop: Math.round(visualViewportOffsetTop),
		keyboardHeight,
		keyboardVisible: keyboardHeight >= keyboardVisibleThreshold,
	};
}
