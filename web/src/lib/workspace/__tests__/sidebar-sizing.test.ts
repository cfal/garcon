import { describe, expect, it } from 'vitest';
import {
	clampDesiredSidebarWidth,
	clampPushSidebarWidth,
	getPushSidebarMaximum,
	resolveRightSidebarMetrics,
} from '../sidebar-sizing';

describe('resolveRightSidebarMetrics', () => {
	it('uses push mode at the exact minimum threshold', () => {
		expect(resolveRightSidebarMetrics(844, 4, 480)).toEqual({ mode: 'push', width: 360 });
	});

	it('clamps push width between the sidebar and main minimums', () => {
		expect(resolveRightSidebarMetrics(1200, 4, 200)).toEqual({ mode: 'push', width: 360 });
		expect(resolveRightSidebarMetrics(1200, 4, 900)).toEqual({ mode: 'push', width: 598 });
	});

	it('never lets the push sidebar become wider than main', () => {
		expect(getPushSidebarMaximum(1_600, 5)).toBeLessThanOrEqual((1_600 - 5) / 2);
		expect(resolveRightSidebarMetrics(1_600, 5, 1_200).width).toBe(797.5);
	});

	it('uses overlay immediately below the threshold without changing desired width', () => {
		expect(resolveRightSidebarMetrics(843, 4, 480)).toEqual({ mode: 'overlay', width: 480 });
		expect(clampDesiredSidebarWidth(480)).toBe(480);
	});

	it('caps overlay width and fills workspaces narrower than the minimum', () => {
		expect(resolveRightSidebarMetrics(800, 4, 900)).toEqual({ mode: 'overlay', width: 560 });
		expect(resolveRightSidebarMetrics(320, 4, 480)).toEqual({ mode: 'overlay', width: 320 });
	});
});

describe('clampDesiredSidebarWidth', () => {
	it('normalizes invalid and extreme persisted values', () => {
		expect(clampDesiredSidebarWidth(Number.NaN)).toBe(360);
		expect(clampDesiredSidebarWidth(20)).toBe(360);
		expect(clampDesiredSidebarWidth(5000)).toBe(1200);
		expect(clampDesiredSidebarWidth(480.7)).toBe(481);
	});

	it('keeps an intentional push resize inside the current visual bounds', () => {
		expect(clampPushSidebarWidth(200, 700)).toBe(360);
		expect(clampPushSidebarWidth(480, 700)).toBe(480);
		expect(clampPushSidebarWidth(900, 700)).toBe(700);
	});
});
