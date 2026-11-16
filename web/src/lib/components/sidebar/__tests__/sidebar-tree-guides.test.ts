import { render } from '@testing-library/svelte';
import { describe, expect, it } from 'vitest';
import SidebarTreeGuides from '../SidebarTreeGuides.svelte';
import { buildSidebarRowModel } from '$lib/sidebar/display/sidebar-row-model';
import { chat, delegated, projectionInput } from '$lib/sidebar/display/__tests__/sidebar-fixtures';
import {
	estimateSidebarVirtualRowSize,
	type SidebarTreeContinuation,
} from '$lib/sidebar/display/sidebar-virtual-chat-list';

const row = buildSidebarRowModel(projectionInput([chat('root'), delegated('child', 'root')]))
	.rows[1];

describe('sidebar tree guide geometry', () => {
	it.each([
		['single-line', 40, '21px', '20px'],
		['compact', 62, '31px', '30px'],
		['detailed', 76, '38px', '37px'],
	] as const)(
		'centers a terminal elbow on the %s content, excluding the separator',
		(layout, height, incomingHeight, armTop) => {
			const { container } = render(SidebarTreeGuides, {
				row,
				guide: row.tree!,
				layout,
				height,
				width: 320,
			});
			const incoming = container.querySelector<HTMLElement>('[data-sidebar-tree-incoming]')!;
			const arm = container.querySelector<HTMLElement>('[data-sidebar-tree-arm]')!;
			expect(incoming.style.height).toBe(incomingHeight);
			expect(incoming.style.left).toBe('12px');
			expect(arm.style.top).toBe(armTop);
			expect(arm.style.width).toBe('7px');
		},
	);

	it.each(['executor', 'project', 'activity', 'status'] as const)(
		'centers %s header elbows without subtracting a chat separator',
		(field) => {
			const chats = [
				chat('root'),
				delegated('child', 'root', {
					executorId: 'remote',
					projectPath: '/other',
					isArchived: true,
					isProcessing: true,
				}),
			];
			const header = buildSidebarRowModel(
				projectionInput(chats, { groupingFields: [{ field, enabled: true }] }),
			).rows.find((item) => item.type !== 'chat' && item.tree)!;
			const height = estimateSidebarVirtualRowSize(header, 'detailed', false, 1);
			const { container } = render(SidebarTreeGuides, {
				row: header,
				guide: header.tree!,
				layout: 'detailed',
				height,
				width: 320,
			});
			const incoming = container.querySelector<HTMLElement>('[data-sidebar-tree-incoming]')!;
			const arm = container.querySelector<HTMLElement>('[data-sidebar-tree-arm]')!;
			expect(incoming.style.height).toBe(`${Math.round(height / 2) + 1}px`);
			expect(arm.style.top).toBe(`${Math.round(height / 2)}px`);
			expect(arm.style.width).toBe('3px');
		},
	);

	it('spans the entire wrapper with nonterminal and ancestor rails, including the separator', () => {
		const { container } = render(SidebarTreeGuides, {
			row: { ...row, depth: 2 },
			guide: {
				parentDepth: 1,
				isLastChild: false,
				continuations: { depth: 0, outer: null },
			},
			layout: 'detailed',
			height: 76,
			width: 320,
		});
		const incoming = container.querySelector<HTMLElement>('[data-sidebar-tree-incoming]')!;
		const continuation = container.querySelector('[data-sidebar-tree-continuation]')!;
		expect(incoming.style.height).toBe('100%');
		expect(continuation.classList.contains('top-0')).toBe(true);
		expect(continuation.classList.contains('bottom-0')).toBe(true);
	});

	it('keeps continuation markup bounded by the current width, including after resizing', async () => {
		let continuations: SidebarTreeContinuation | null = null;
		for (let depth = 0; depth < 2000; depth++) continuations = { depth, outer: continuations };
		const guide = { parentDepth: 2000, isLastChild: false, continuations };
		const props = { row, guide, layout: 'detailed' as const, height: 76, width: 320 };
		const view = render(SidebarTreeGuides, props);
		expect(view.container.querySelectorAll('[data-sidebar-tree-continuation]')).toHaveLength(26);
		expect(view.container.querySelector('[data-sidebar-tree-incoming]')).toBeNull();
		await view.rerender({ ...props, width: 152 });
		expect(view.container.querySelectorAll('[data-sidebar-tree-continuation]')).toHaveLength(12);
		expect(view.container.querySelector('[data-sidebar-tree-continuation="12"]')).toBeNull();
	});
});
