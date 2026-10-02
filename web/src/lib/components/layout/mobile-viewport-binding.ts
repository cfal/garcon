import { computeMobileViewportMetrics, type MobileViewportMetrics } from './mobile-viewport';

export function bindMobileViewport(
	onMetrics: (metrics: MobileViewportMetrics) => void,
): (() => void) | undefined {
	if (typeof window === 'undefined' || !window.visualViewport) return;
	const viewport = window.visualViewport;
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
		document.documentElement.style.setProperty('--app-height', `${metrics.appHeight}px`);
		document.documentElement.style.setProperty(
			'--app-viewport-offset-top',
			`${metrics.viewportOffsetTop}px`,
		);
		document.documentElement.style.setProperty(
			'--app-viewport-center-y',
			`${metrics.viewportCenterY}px`,
		);
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
