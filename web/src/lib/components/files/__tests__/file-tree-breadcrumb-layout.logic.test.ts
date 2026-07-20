import { describe, expect, it } from 'vitest';
import { selectFileTreeBreadcrumbLayout } from '../file-tree-breadcrumb-layout.js';

const widths = new Map([
	[0, 60],
	[1, 70],
	[2, 80],
	[3, 90],
]);

describe('selectFileTreeBreadcrumbLayout', () => {
	it('shows every segment when measured content fits', () => {
		expect(
			selectFileTreeBreadcrumbLayout({
				count: 4,
				availableWidth: 340,
				segmentWidths: widths,
				separatorWidth: 8,
				overflowWidth: 24,
				gap: 2,
			}),
		).toEqual({ visibleIndices: [0, 1, 2, 3], overflowIndices: [] });
	});

	it('preserves the base and current segment while collapsing middle ancestors', () => {
		expect(
			selectFileTreeBreadcrumbLayout({
				count: 4,
				availableWidth: 210,
				segmentWidths: widths,
				separatorWidth: 8,
				overflowWidth: 24,
				gap: 2,
			}),
		).toEqual({ visibleIndices: [0, 3], overflowIndices: [1, 2] });
	});

	it('waits for complete measurements before collapsing', () => {
		expect(
			selectFileTreeBreadcrumbLayout({
				count: 4,
				availableWidth: 100,
				segmentWidths: new Map([[0, 60]]),
				separatorWidth: 8,
				overflowWidth: 24,
				gap: 2,
			}),
		).toEqual({ visibleIndices: [0, 1, 2, 3], overflowIndices: [] });
	});
});
