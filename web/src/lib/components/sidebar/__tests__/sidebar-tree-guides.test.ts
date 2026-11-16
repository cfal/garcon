import { render } from '@testing-library/svelte';
import { describe, expect, it } from 'vitest';
import SidebarTreeGuides from '../SidebarTreeGuides.svelte';
import SidebarDisplayPreview from '../SidebarDisplayPreview.svelte';
import SidebarDelegationArrow from '../SidebarDelegationArrow.svelte';
import { DEFAULT_SIDEBAR_DISPLAY_OPTIONS } from '$lib/sidebar/display/sidebar-display-options';
import { buildSidebarRowModel } from '$lib/sidebar/display/sidebar-row-model';
import { chat, delegated, projectionInput } from '$lib/sidebar/display/__tests__/sidebar-fixtures';
import {
	estimateSidebarVirtualRowSize,
	type SidebarTreeContinuation,
} from '$lib/sidebar/display/sidebar-virtual-chat-list';

const row = buildSidebarRowModel(
	projectionInput([chat('root'), delegated('child', 'root')]),
).rows.find((item) => item.key === 'chat:child')!;

describe('sidebar tree guide geometry', () => {
	it('renders one prefix character per level without growing the element count', async () => {
		const view = render(SidebarDelegationArrow, { depth: 1 });
		const arrow = view.container.querySelector('[data-sidebar-delegation-arrow]')!;
		expect(arrow.textContent).toBe('\u21b3');
		for (const depth of [2, 3, 2000]) {
			await view.rerender({ depth });
			expect(arrow.isConnected).toBe(true);
			expect(arrow.textContent).toBe('\u21b3'.repeat(depth));
			expect(arrow.childElementCount).toBe(0);
		}
	});

	it.each([
		[40, '21px', '20px'],
		[43, '22px', '21px'],
	] as const)(
		'centers a terminal elbow on single-line content of height %s',
		(contentHeight, incomingHeight, armTop) => {
			const { container } = render(SidebarTreeGuides, {
				row,
				guide: row.tree!,
				contentHeight,
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

	it.each([
		[1, '19px'],
		[15 / 14, '21px'],
	] as const)(
		'centers single-line preview strokes inside the bottom border at scale %s',
		(chatFontScale, armTop) => {
			const { container } = render(SidebarDisplayPreview, {
				options: {
					...DEFAULT_SIDEBAR_DISPLAY_OPTIONS,
					chatItemLayout: 'single-line',
					chatFontScale,
				},
			});
			const arm = container.querySelector<HTMLElement>('[data-sidebar-tree-arm]')!;
			expect(arm.style.top).toBe(armTop);
		},
	);

	it.each(['compact', 'detailed'] as const)(
		'uses title arrows instead of rails in the %s preview',
		(chatItemLayout) => {
			const { container } = render(SidebarDisplayPreview, {
				options: { ...DEFAULT_SIDEBAR_DISPLAY_OPTIONS, chatItemLayout },
			});
			expect(container.querySelector('[data-sidebar-tree-guides]')).toBeNull();
			const arrows = container.querySelectorAll('[data-sidebar-delegation-arrow]');
			expect(arrows).toHaveLength(1);
			expect(arrows[0].closest('[data-slot="chat-summary-header"]')).not.toBeNull();
			expect(arrows[0].parentElement!.firstElementChild).toBe(arrows[0]);
			expect(arrows[0].getAttribute('aria-hidden')).toBe('true');
			expect(arrows[0].textContent).toBe('\u21b3');
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
				contentHeight: height,
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
				delegationDepth: 2,
				isLastChild: false,
				continuations: { depth: 0, outer: null },
			},
			contentHeight: 74,
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
		const guide = { parentDepth: 2000, delegationDepth: 2001, isLastChild: false, continuations };
		const props = { row, guide, contentHeight: 74, width: 320 };
		const view = render(SidebarTreeGuides, props);
		expect(view.container.querySelectorAll('[data-sidebar-tree-continuation]')).toHaveLength(26);
		expect(view.container.querySelector('[data-sidebar-tree-incoming]')).toBeNull();
		await view.rerender({ ...props, width: 152 });
		expect(view.container.querySelectorAll('[data-sidebar-tree-continuation]')).toHaveLength(12);
		expect(view.container.querySelector('[data-sidebar-tree-continuation="12"]')).toBeNull();
	});
});
