import { describe, expect, it } from 'vitest';
import { canonicalWorkspaceSnapshot } from '../canonical-layout';
import { WORKSPACE_WINDOW_RESOURCE_CEILING } from '../surface-types';
import { planChatTiles, workingChatIdsForTiling } from '../workspace-chat-tiling';
import { reduceWorkspaceLayout } from '../workspace-layout.svelte';
import { computeWindowRects } from '../window-tree';

const chats = Array.from({ length: 30 }, (_, i) => `chat-${i}`);

it('prioritizes chats waiting for input while respecting processing authority and roster order', () => {
	expect(
		workingChatIdsForTiling([
			{ id: 'one', isProcessing: true, activityStatus: 'working' },
			{ id: 'stale', isProcessing: false, activityStatus: 'pending-user-action' },
			{ id: 'two', isProcessing: true, activityStatus: null },
			{ id: 'waiting', isProcessing: true, activityStatus: 'pending-user-action' },
		]),
	).toEqual(['waiting', 'one', 'two']);
});

describe('chat tile geometry', () => {
	it.each([
		{ width: 1080, height: 480, count: 6, rowLengths: [3, 3] },
		{ width: 1080, height: 720, count: 6, rowLengths: [3, 3] },
		{ width: 1080, height: 960, count: 6, rowLengths: [2, 2, 2] },
		{ width: 1080, height: 480, count: 5, rowLengths: [3, 2] },
		{ width: 360, height: 720, count: 4, rowLengths: [1, 1, 1] },
		{ width: 1500, height: 240, count: 5, rowLengths: [4] },
		{ width: 1500, height: 239, count: 5, rowLengths: [1] },
		{ width: 700, height: 400, count: 2, rowLengths: [1] },
	])('fits $count chats into $width x $height', ({ width, height, count, rowLengths }) => {
		const snapshot = canonicalWorkspaceSnapshot();
		const rows = planChatTiles(snapshot, chats.slice(0, count), { width, height });
		expect(rows.map((row) => row.length)).toEqual(rowLengths);
		const tiledChatIds = rows.flat().map((tile) => tile.chatId);
		expect(tiledChatIds).toEqual(chats.slice(0, tiledChatIds.length));
		const { desktopRoot } = reduceWorkspaceLayout(snapshot, [{ type: 'tile-chats', rows }]);
		const rects = computeWindowRects(desktopRoot).windows;
		for (const [y, row] of rows.entries()) {
			for (const { windowId } of row) {
				const rect = rects.find((candidate) => candidate.workspaceWindow.id === windowId)!.rect;
				expect(rect.height).toBeCloseTo(1 / rows.length);
				expect(rect.width).toBeCloseTo(1 / row.length);
				expect(rect.top).toBeCloseTo(y / rows.length);
			}
		}
	});

	it('respects the window budget and uses a single pane before measurement', () => {
		const snapshot = canonicalWorkspaceSnapshot();
		const rows = planChatTiles(snapshot, chats, { width: 10000, height: 10000 });
		expect(rows.flat()).toHaveLength(WORKSPACE_WINDOW_RESOURCE_CEILING);
		expect(() => reduceWorkspaceLayout(snapshot, [{ type: 'tile-chats', rows }])).not.toThrow();
		expect(planChatTiles(snapshot, chats, null).flat()).toHaveLength(1);
	});
});
