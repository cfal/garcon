import { describe, expect, it } from 'vitest';
import { shouldShowSidebarBackToTop } from '../sidebar-back-to-top';

describe('sidebar back-to-top visibility', () => {
	it('appears after one viewport and stays visible until half a viewport', () => {
		expect(
			shouldShowSidebarBackToTop({
				scrollTop: 400,
				viewportHeight: 640,
				currentlyVisible: false,
			}),
		).toBe(false);
		expect(
			shouldShowSidebarBackToTop({
				scrollTop: 640,
				viewportHeight: 640,
				currentlyVisible: false,
			}),
		).toBe(false);
		expect(
			shouldShowSidebarBackToTop({
				scrollTop: 641,
				viewportHeight: 640,
				currentlyVisible: false,
			}),
		).toBe(true);
		expect(
			shouldShowSidebarBackToTop({
				scrollTop: 321,
				viewportHeight: 640,
				currentlyVisible: true,
			}),
		).toBe(true);
		expect(
			shouldShowSidebarBackToTop({
				scrollTop: 320,
				viewportHeight: 640,
				currentlyVisible: true,
			}),
		).toBe(false);
	});

	it('stays hidden for invalid heights and elastic leading overscroll', () => {
		expect(
			shouldShowSidebarBackToTop({
				scrollTop: 900,
				viewportHeight: 0,
				currentlyVisible: false,
			}),
		).toBe(false);
		expect(
			shouldShowSidebarBackToTop({
				scrollTop: -50,
				viewportHeight: 640,
				currentlyVisible: true,
			}),
		).toBe(false);
	});
});
