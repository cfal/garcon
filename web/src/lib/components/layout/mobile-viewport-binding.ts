import { computeMobileViewportMetrics, type MobileViewportMetrics } from './mobile-viewport';

export const WIDE_FINE_POINTER_QUERY = '(min-width: 769px) and (pointer: fine) and (any-pointer: fine)';
export const COARSE_POINTER_QUERY = '(any-pointer: coarse)';

export function bindMobileViewport(
	onMetrics: (metrics: MobileViewportMetrics) => void,
): (() => void) | undefined {
	if (typeof window === 'undefined' || !window.visualViewport) return;
	const viewport = window.visualViewport;
	const wideFinePointer = window.matchMedia?.(WIDE_FINE_POINTER_QUERY);
	const coarsePointer = window.matchMedia?.(COARSE_POINTER_QUERY);
	let frameId: number | null = null;
	let previousAppHeight: number | null = null;
	let baselineAppHeight: number | null = null;

	function clearViewportOverrides() {
		document.documentElement.style.removeProperty('--app-height');
		document.documentElement.style.removeProperty('--app-viewport-offset-top');
		document.documentElement.style.removeProperty('--app-viewport-center-y');
	}

	function applyViewportMetrics() {
		frameId = null;
		const metrics = computeMobileViewportMetrics({
			visualViewportHeight: viewport.height,
			visualViewportOffsetTop: viewport.offsetTop,
			windowInnerHeight: window.innerHeight,
			baselineAppHeight,
			previousAppHeight,
		});
		previousAppHeight = metrics.appHeight;
		onMetrics(metrics);
		if (!metrics.keyboardVisible) {
			baselineAppHeight = metrics.appHeight;
			// Leaves safe-area geometry to CSS unless the keyboard occludes the viewport.
			clearViewportOverrides();
			return;
		}
		const style = document.documentElement.style;
		const skipUnchanged =
			wideFinePointer?.matches &&
			coarsePointer?.matches === false &&
			window.navigator.maxTouchPoints === 0;
		function setPixels(name: string, pixels: number) {
			const value = `${pixels}px`;
			if (
				skipUnchanged &&
				style.getPropertyValue(name) === value &&
				!style.getPropertyPriority(name)
			) return;
			style.setProperty(name, value);
		}
		setPixels('--app-height', metrics.appHeight);
		setPixels('--app-viewport-offset-top', metrics.viewportOffsetTop);
		setPixels('--app-viewport-center-y', metrics.viewportCenterY);
	}

	function scheduleViewportMetrics() {
		if (frameId !== null) return;
		frameId = requestAnimationFrame(applyViewportMetrics);
	}

	function handleVisibilityChange() {
		if (document.visibilityState === 'visible') scheduleViewportMetrics();
	}

	scheduleViewportMetrics();
	viewport.addEventListener('resize', scheduleViewportMetrics);
	viewport.addEventListener('scroll', scheduleViewportMetrics);
	window.addEventListener('resize', scheduleViewportMetrics);
	window.addEventListener('pageshow', scheduleViewportMetrics);
	document.addEventListener('visibilitychange', handleVisibilityChange);
	return () => {
		if (frameId !== null) cancelAnimationFrame(frameId);
		viewport.removeEventListener('resize', scheduleViewportMetrics);
		viewport.removeEventListener('scroll', scheduleViewportMetrics);
		window.removeEventListener('resize', scheduleViewportMetrics);
		window.removeEventListener('pageshow', scheduleViewportMetrics);
		document.removeEventListener('visibilitychange', handleVisibilityChange);
		clearViewportOverrides();
	};
}
