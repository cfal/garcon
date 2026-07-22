import { describe, expect, it } from 'vitest';
import {
	DEFAULT_DESKTOP_LAYOUT_ORDER,
	moveDesktopLayoutPane,
	normalizeDesktopLayoutOrder,
	resolveDesktopLayout,
	resolveMainInlineInsets,
	resolveWorkspaceSidebarOverlayInsets,
	type DesktopLayoutEdge,
	type DesktopLayoutOrder,
} from '../desktop-layout';

describe('desktop layout', () => {
	it.each<[DesktopLayoutOrder, DesktopLayoutEdge, DesktopLayoutEdge]>([
		[['chat-list', 'main', 'workspace-sidebar'], 'end', 'start'],
		[['chat-list', 'workspace-sidebar', 'main'], 'end', 'end'],
		[['main', 'chat-list', 'workspace-sidebar'], 'start', 'start'],
		[['main', 'workspace-sidebar', 'chat-list'], 'start', 'start'],
		[['workspace-sidebar', 'chat-list', 'main'], 'end', 'end'],
		[['workspace-sidebar', 'main', 'chat-list'], 'start', 'end'],
	])('resolves pane edges for %j', (order, chatEdge, workspaceEdge) => {
		const result = resolveDesktopLayout(order);

		expect(result.chatListEdge).toBe(chatEdge);
		expect(result.workspaceSidebarEdge).toBe(workspaceEdge);
	});

	it.each([
		undefined,
		null,
		'main',
		['chat-list', 'main'],
		['chat-list', 'main', 'workspace-sidebar', 'extra'],
		['chat-list', 'main', 'main'],
		['chat-list', 'main', 'unknown'],
		['chat-list', 'main', 42],
	])('falls back atomically for malformed order %j', (value) => {
		expect(normalizeDesktopLayoutOrder(value)).toEqual(DEFAULT_DESKTOP_LAYOUT_ORDER);
	});

	it('copies valid and default orders', () => {
		const valid: DesktopLayoutOrder = ['main', 'workspace-sidebar', 'chat-list'];
		const normalizedValid = normalizeDesktopLayoutOrder(valid);
		const normalizedDefault = normalizeDesktopLayoutOrder(undefined);

		expect(normalizedValid).toEqual(valid);
		expect(normalizedValid).not.toBe(valid);
		expect(normalizedDefault).toEqual(DEFAULT_DESKTOP_LAYOUT_ORDER);
		expect(normalizedDefault).not.toBe(DEFAULT_DESKTOP_LAYOUT_ORDER);
	});

	it('moves a pane and clamps the destination', () => {
		expect(moveDesktopLayoutPane(DEFAULT_DESKTOP_LAYOUT_ORDER, 0, 2)).toEqual([
			'main',
			'workspace-sidebar',
			'chat-list',
		]);
		expect(moveDesktopLayoutPane(DEFAULT_DESKTOP_LAYOUT_ORDER, 2, -1)).toEqual([
			'workspace-sidebar',
			'chat-list',
			'main',
		]);
		expect(moveDesktopLayoutPane(DEFAULT_DESKTOP_LAYOUT_ORDER, -1, 1)).toEqual(
			DEFAULT_DESKTOP_LAYOUT_ORDER,
		);
	});

	it('resolves main insets from visible pane widths', () => {
		expect(
			resolveMainInlineInsets(['chat-list', 'main', 'workspace-sidebar'], {
				chatList: 320,
				workspaceSidebar: 480,
			}),
		).toEqual({ start: 320, end: 480 });
		expect(
			resolveMainInlineInsets(['workspace-sidebar', 'chat-list', 'main'], {
				chatList: 320,
				workspaceSidebar: 480,
			}),
		).toEqual({ start: 800, end: 0 });
		expect(
			resolveMainInlineInsets(['main', 'chat-list', 'workspace-sidebar'], {
				chatList: 0,
				workspaceSidebar: 0,
			}),
		).toEqual({ start: 0, end: 0 });
	});

	it.each([
		[['chat-list', 'main', 'workspace-sidebar'], { start: 0, end: 0 }],
		[['chat-list', 'workspace-sidebar', 'main'], { start: 320, end: 0 }],
		[['main', 'chat-list', 'workspace-sidebar'], { start: 0, end: 0 }],
		[['main', 'workspace-sidebar', 'chat-list'], { start: 0, end: 320 }],
		[['workspace-sidebar', 'chat-list', 'main'], { start: 0, end: 0 }],
		[['workspace-sidebar', 'main', 'chat-list'], { start: 0, end: 0 }],
	] satisfies Array<[DesktopLayoutOrder, { start: number; end: number }]>)(
		'anchors the overlay at the workspace sidebar position for %j',
		(order, expected) => {
			expect(resolveWorkspaceSidebarOverlayInsets(order, 320)).toEqual(expected);
		},
	);
});
