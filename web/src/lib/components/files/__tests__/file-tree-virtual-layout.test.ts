import { describe, expect, it } from 'vitest';
import {
	createFileTreeVirtualLayout,
	FILE_TREE_MAX_LAYOUT_HEIGHT,
	fileTreeLogicalItemStart,
	fileTreeLogicalToPhysicalOffset,
	fileTreeMaximumPhysicalScrollOffset,
	fileTreePhysicalToLogicalOffset,
	fileTreeVirtualRowOffset,
} from '../file-tree-virtual-layout.js';

describe('file tree virtual layout', () => {
	it('keeps ordinary lists in their native coordinate space', () => {
		const layout = createFileTreeVirtualLayout({
			rowCount: 1_000,
			rowHeight: 32,
			viewportHeight: 640,
			scrollMargin: 32,
		});

		expect(layout.compressed).toBe(false);
		expect(fileTreePhysicalToLogicalOffset(layout, 6_400)).toBe(6_400);
		expect(fileTreeLogicalToPhysicalOffset(layout, 6_400)).toBe(6_400);
		expect(fileTreeVirtualRowOffset(layout, 200, 6_400, 8)).toBe(6_400);
	});

	it('projects a large logical list into a cross-browser bounded layout', () => {
		const layout = createFileTreeVirtualLayout({
			rowCount: 500_000,
			rowHeight: 44,
			viewportHeight: 900,
			scrollMargin: 32,
		});
		const physicalEnd = layout.scrollMargin + layout.bodyHeight - layout.viewportHeight;
		const logicalEnd = layout.scrollMargin + layout.logicalBodyHeight - layout.viewportHeight;

		expect(layout.compressed).toBe(true);
		expect(layout.bodyHeight).toBe(FILE_TREE_MAX_LAYOUT_HEIGHT);
		expect(fileTreePhysicalToLogicalOffset(layout, physicalEnd)).toBe(logicalEnd);
		expect(fileTreeLogicalToPhysicalOffset(layout, logicalEnd)).toBe(physicalEnd);
		expect(fileTreeMaximumPhysicalScrollOffset(layout)).toBe(physicalEnd);
		expect(fileTreeLogicalItemStart(layout, layout.rowCount - 1) - logicalEnd).toBe(
			layout.viewportHeight - layout.rowHeight,
		);
	});

	it('keeps retained offscreen rows inside a small overflow buffer', () => {
		const layout = createFileTreeVirtualLayout({
			rowCount: 500_000,
			rowHeight: 44,
			viewportHeight: 900,
			scrollMargin: 32,
		});
		const physicalMiddle = (layout.scrollMargin + layout.bodyHeight - layout.viewportHeight) / 2;
		const firstRowOffset = fileTreeVirtualRowOffset(layout, 0, physicalMiddle, 8);
		const firstRowViewportTop = layout.scrollMargin + firstRowOffset - physicalMiddle;

		expect(firstRowViewportTop).toBe(-layout.rowHeight * 9);
	});

	it('keeps retained focus wrappers inside the physical body near its end', () => {
		const layout = createFileTreeVirtualLayout({
			rowCount: 500_000,
			rowHeight: 32,
			viewportHeight: 900,
			scrollMargin: 32,
		});
		const nearEnd = fileTreeMaximumPhysicalScrollOffset(layout) - 500;
		const lastRowOffset = fileTreeVirtualRowOffset(layout, layout.rowCount - 1, nearEnd, 8);

		expect(lastRowOffset).toBeLessThanOrEqual(layout.bodyHeight - layout.rowHeight);
		expect(lastRowOffset + layout.rowHeight).toBeLessThanOrEqual(layout.bodyHeight);
	});
});
