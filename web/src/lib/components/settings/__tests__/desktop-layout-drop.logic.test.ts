import { describe, expect, it } from 'vitest';
import type { DesktopLayoutOrder, DesktopLayoutPane } from '$lib/layout/desktop-layout.js';
import { reorderDesktopLayoutPaneFromDrop } from '../desktop-layout-drop.js';

const order: DesktopLayoutOrder = ['chat-list', 'main', 'workspace-sidebar'];

describe('desktop layout drag and drop', () => {
	it.each<[DesktopLayoutPane, DesktopLayoutPane, 'top' | 'bottom', DesktopLayoutOrder]>([
		['chat-list', 'main', 'bottom', ['main', 'chat-list', 'workspace-sidebar']],
		['chat-list', 'workspace-sidebar', 'bottom', ['main', 'workspace-sidebar', 'chat-list']],
		['workspace-sidebar', 'main', 'top', ['chat-list', 'workspace-sidebar', 'main']],
		['workspace-sidebar', 'chat-list', 'top', ['workspace-sidebar', 'chat-list', 'main']],
		['main', 'chat-list', 'top', ['main', 'chat-list', 'workspace-sidebar']],
		['main', 'chat-list', 'bottom', ['chat-list', 'main', 'workspace-sidebar']],
	])('moves %s onto %s at its %s edge', (source, target, edge, expected) => {
		expect(reorderDesktopLayoutPaneFromDrop(order, source, target, edge)).toEqual(expected);
	});
});
