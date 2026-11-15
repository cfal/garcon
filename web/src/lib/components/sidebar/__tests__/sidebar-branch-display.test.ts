import { cleanup, fireEvent, render, screen, within } from '@testing-library/svelte';
import { afterEach, expect, it, vi } from 'vitest';
import SidebarChatListHost from './SidebarChatListHost.svelte';
import { chat, delegated } from '$lib/sidebar/display/__tests__/sidebar-fixtures';

afterEach(cleanup);

it.each([false, true])('search expansion cannot mutate saved collapse state (collapsed: %s)', async (collapsed) => {
	const chats = [chat('parent'), delegated('child', 'parent')];
	const toggle = vi.fn();
	const keys = new Set(collapsed ? ['delegation:parent'] : []);
	const view = render(SidebarChatListHost, {
		chats, filteredChats: [chats[1]], searchFilter: 'child',
		displayOptions: { nestDelegatedChats: true, groupingFields: [{ field: 'project', enabled: true }] },
		collapsedProjectKeys: keys, onToggleProjectCollapsed: toggle,
	});
	const disclosure = screen.getByRole('button', { name: 'Collapse delegated chats under parent' });
	expect(disclosure).toHaveProperty('disabled', true);
	await fireEvent.click(disclosure);
	for (const header of view.container.querySelectorAll<HTMLButtonElement>('[data-sidebar-project-header]')) {
		expect(header.disabled).toBe(true);
		await fireEvent.click(header);
	}
	expect(toggle).not.toHaveBeenCalled();
	await view.rerender({ searchFilter: '', filteredChats: chats });
	expect(view.container.querySelector('[data-sidebar-virtual-row="child"]') !== null).toBe(!collapsed);
});

it('names untitled disclosures and exposes descendant summaries and newer activity', async () => {
	const chats = [chat('parent', { title: '' }), delegated('child', 'parent', {
		isUnread: true, isProcessing: true, lastActivityAt: '2026-02-01T00:00:00Z',
	})];
	const view = render(SidebarChatListHost, { chats, displayOptions: { nestDelegatedChats: true } });
	const disclosure = screen.getByRole('button', { name: 'Collapse delegated chats under New Chat' });
	const parent = within(view.container.querySelector<HTMLElement>('[data-sidebar-virtual-row="parent"]')!);
	const navigation = parent.getByRole('button', { name: /1 delegated chats, 1 running, 1 unread/ });
	expect(navigation.getAttribute('aria-describedby')).toBeTruthy();
	expect(navigation.title).toContain('Latest branch activity');
	await fireEvent.click(disclosure);
	expect(screen.getByRole('button', { name: 'Expand delegated chats under New Chat' })).toBeTruthy();
	await view.rerender({ chats: [chats[0], { ...chats[1], lastActivityAt: chats[0].lastActivityAt }] });
	expect(navigation.hasAttribute('aria-describedby')).toBe(false);
});

it('uses presentation depth for reordered group headings', () => {
	const view = render(SidebarChatListHost, { chats: [chat('a')], displayOptions: {
		groupingFields: [{ field: 'project', enabled: true }, { field: 'executor', enabled: true }, { field: 'status', enabled: true }],
	} });
	expect([...view.container.querySelectorAll('[role="heading"]')].map((heading) => heading.getAttribute('aria-level'))).toEqual(['2', '3', '4']);
});

it('aligns a failed delegated row with successful nested content', async () => {
	const child = delegated('child', 'parent');
	Object.defineProperty(child, 'lastMessage', { get() { throw new Error('Synthetic preview failure'); } });
	const view = render(SidebarChatListHost, {
		chats: [chat('parent'), child], displayOptions: { nestDelegatedChats: true, chatItemLayout: 'detailed' },
	});
	const fallback = await screen.findByText('child');
	expect(fallback.getAttribute('data-sidebar-virtual-row-error')).toBe('child');
	expect(fallback.style.paddingLeft).toBe('12px');
	expect(view.container.querySelector('[data-sidebar-virtual-row="parent"]')).toBeTruthy();
});
