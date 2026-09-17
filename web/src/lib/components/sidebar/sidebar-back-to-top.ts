export interface SidebarBackToTopVisibilityInput {
	readonly scrollTop: number;
	readonly viewportHeight: number;
	readonly currentlyVisible: boolean;
}

export function shouldShowSidebarBackToTop({
	scrollTop,
	viewportHeight,
	currentlyVisible,
}: SidebarBackToTopVisibilityInput): boolean {
	if (viewportHeight <= 0) return false;
	const distanceFromTop = Math.max(0, scrollTop);
	// Uses separate thresholds to prevent flicker near the visibility boundary.
	const threshold = viewportHeight * (currentlyVisible ? 0.5 : 1);
	return distanceFromTop > threshold;
}
