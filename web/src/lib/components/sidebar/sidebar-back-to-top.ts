export interface SidebarBackToTopPosition {
	readonly scrollTop: number;
	readonly viewportHeight: number;
	readonly currentlyVisible: boolean;
}

export function shouldShowSidebarBackToTop({
	scrollTop,
	viewportHeight,
	currentlyVisible,
}: SidebarBackToTopPosition): boolean {
	if (viewportHeight <= 0) return false;
	const distanceFromTop = Math.max(0, scrollTop);
	const threshold = viewportHeight * (currentlyVisible ? 0.5 : 1);
	return distanceFromTop > threshold;
}
