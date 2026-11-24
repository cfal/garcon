import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { afterEach, expect, it, vi } from 'vitest';
import SidebarChatListHost from './SidebarChatListHost.svelte';
import { chat, delegated } from '$lib/sidebar/display/__tests__/sidebar-fixtures';

afterEach(cleanup);

it.each([false, true])(
	'search expansion cannot mutate saved collapse state (collapsed: %s)',
	async (collapsed) => {
		const chats = [chat('parent'), delegated('child', 'parent')];
		const toggle = vi.fn();
		const keys = new Set(collapsed ? ['delegation:parent'] : []);
		const view = render(SidebarChatListHost, {
			chats,
			filteredChats: [chats[1]],
			searchFilter: 'child',
			displayOptions: {
				nestDelegatedChats: true,
				groupingFields: [{ field: 'project', enabled: true }],
			},
			collapsedProjectKeys: keys,
			onToggleProjectCollapsed: toggle,
		});
		const parent = within(
			view.container.querySelector<HTMLElement>('[data-sidebar-virtual-row="parent"]')!,
		);
		await fireEvent.click(parent.getByRole('button', { name: 'Chat actions' }));
		const collapse = await screen.findByRole('menuitem', { name: 'Collapse delegated chats' });
		expect(collapse.getAttribute('aria-disabled')).toBe('true');
		await fireEvent.click(collapse);
		await fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
		for (const header of view.container.querySelectorAll<HTMLButtonElement>(
			'[data-sidebar-project-header]',
		)) {
			expect(header.disabled).toBe(true);
			await fireEvent.click(header);
		}
		expect(toggle).not.toHaveBeenCalled();
		await view.rerender({ searchFilter: '', filteredChats: chats });
		expect(view.container.querySelector('[data-sidebar-virtual-row="child"]') !== null).toBe(
			!collapsed,
		);
	},
);

it('exposes descendant summaries and newer activity without a disclosure gutter', async () => {
	const chats = [
		chat('parent', { title: '' }),
		delegated('child', 'parent', {
			isUnread: true,
			isProcessing: true,
			lastActivityAt: '2026-02-01T00:00:00Z',
		}),
	];
	const view = render(SidebarChatListHost, { chats, displayOptions: { nestDelegatedChats: true } });
	const parent = within(
		view.container.querySelector<HTMLElement>('[data-sidebar-virtual-row="parent"]')!,
	);
	const navigation = parent.getByRole('button', { name: /1 delegated chats, 1 running, 1 unread/ });
	expect(navigation.getAttribute('aria-describedby')).toBeTruthy();
	expect(navigation.title).toContain('Latest branch activity');
	expect(view.container.querySelector('[data-sidebar-virtual-row-content] > button')).toBeNull();
	await view.rerender({
		chats: [chats[0], { ...chats[1], lastActivityAt: chats[0].lastActivityAt }],
	});
	expect(navigation.hasAttribute('aria-describedby')).toBe(false);
});

it('uses presentation depth for reordered group headings', () => {
	const view = render(SidebarChatListHost, {
		chats: [chat('a')],
		displayOptions: {
			groupingFields: [
				{ field: 'project', enabled: true },
				{ field: 'executor', enabled: true },
				{ field: 'status', enabled: true },
			],
		},
	});
	expect(
		[...view.container.querySelectorAll('[role="heading"]')].map((heading) =>
			heading.getAttribute('aria-level'),
		),
	).toEqual(['2', '3', '4']);
});

it('aligns a failed delegated row with successful nested content', async () => {
	const child = delegated('child', 'parent');
	Object.defineProperty(child, 'lastMessage', {
		get() {
			throw new Error('Synthetic preview failure');
		},
	});
	const view = render(SidebarChatListHost, {
		chats: [chat('parent'), child],
		displayOptions: { nestDelegatedChats: true, chatItemLayout: 'detailed' },
	});
	const fallback = await screen.findByText('child');
	expect(fallback.getAttribute('data-sidebar-virtual-row-error')).toBe('child');
	expect(fallback.style.paddingLeft).toBe('12px');
	expect(view.container.querySelector('[data-sidebar-virtual-row="parent"]')).toBeTruthy();
});

it.each([false, true])(
	'collapses and expands from the parent menu (mobile: %s)',
	async (isMobile) => {
		const view = render(SidebarChatListHost, {
			chats: [chat('parent'), delegated('child', 'parent'), chat('peer')],
			selectedChatId: 'child',
			isMobile,
			displayOptions: { nestDelegatedChats: true },
		});
		const parentRow = view.container.querySelector<HTMLElement>(
			'[data-sidebar-virtual-row="parent"]',
		)!;
		const openParentMenu = async () => {
			if (isMobile)
				await fireEvent.click(within(parentRow).getByRole('button', { name: 'Chat actions' }));
			else await fireEvent.contextMenu(within(parentRow).getByRole('button', { name: /^parent / }));
		};
		await openParentMenu();
		await fireEvent.click(
			await screen.findByRole('menuitem', { name: 'Collapse delegated chats' }),
		);
		await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
		expect(view.container.querySelector('[data-sidebar-virtual-row="child"]')).toBeNull();
		expect(parentRow.className).toContain('bg-sidebar-chat-item-selected-bg');
		await openParentMenu();
		await fireEvent.click(await screen.findByRole('menuitem', { name: 'Expand delegated chats' }));
		await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
		expect(view.container.querySelector('[data-sidebar-virtual-row="child"]')).toBeTruthy();
		const childRow = view.container.querySelector<HTMLElement>(
			'[data-sidebar-virtual-row="child"]',
		)!;
		await fireEvent.click(within(childRow).getByRole('button', { name: 'Chat actions' }));
		expect(screen.queryByRole('menuitem', { name: /delegated chats/ })).toBeNull();
	},
);

it.each(['single-line', 'compact', 'detailed'] as const)(
	'keeps %s chat padding inside the full-width item',
	async (chatItemLayout) => {
		const view = render(SidebarChatListHost, {
			chats: [chat('parent'), delegated('child', 'parent'), chat('peer')],
			displayOptions: { nestDelegatedChats: true, chatItemLayout },
		});
		for (const isMobile of [false, true]) {
			await view.rerender({ isMobile });
			for (const [id, padding] of [
				['parent', '12px'],
				['child', chatItemLayout === 'single-line' ? '24px' : '12px'],
				['peer', '12px'],
			]) {
				const row = view.container.querySelector<HTMLElement>(
					`[data-sidebar-virtual-row="${id}"]`,
				)!;
				const navigation = row.querySelector<HTMLButtonElement>('button')!;
				expect(navigation.style.paddingLeft).toBe(padding);
				expect(navigation.className).toContain('hover:bg-sidebar-chat-item-hover-bg');
				expect(navigation.className).toContain('pr-2');
				expect(row.querySelector('[data-sidebar-virtual-row-content]')?.children).toHaveLength(1);
			}
		}
	},
);
