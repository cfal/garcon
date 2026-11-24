import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { tick } from 'svelte';
import { afterEach, expect, it, onTestFinished, vi } from 'vitest';
import type { ChatListEntry, ChatListResponse } from '$shared/chat-list';
import { ChatSessionsStore } from '$lib/chat/sessions/chat-sessions.svelte';
import { SidebarProjectCollapseStore } from '$lib/sidebar/projects/sidebar-project-collapse.svelte';
import { sidebarGroupCollapseKey, sidebarProjectKey } from '$lib/sidebar/display/sidebar-row-model';
import { chat, delegated } from '$lib/sidebar/display/__tests__/sidebar-fixtures';
import { LOCAL_STORAGE_KEYS } from '$lib/utils/local-persistence';
import SidebarHost from './SidebarHost.svelte';

afterEach(() => {
	cleanup();
	localStorage.removeItem(LOCAL_STORAGE_KEYS.sidebarProjectCollapse);
});

function createCollapseStore() {
	const store = new SidebarProjectCollapseStore();
	onTestFinished(() => store.destroy());
	return store;
}

function roster(...sessions: ChatListEntry[]): ChatListResponse {
	return { sessions, total: sessions.length, lastSelectedChatId: null };
}

function rosterEntry(id: string): ChatListEntry {
	return {
		...chat(id),
		orderGroup: 'normal',
		agentOwnershipEpoch: 'epoch',
		isActive: true,
		activity: { createdAt: null, lastActivityAt: null, lastReadAt: null },
		preview: { lastMessage: '' },
	};
}

it('records an expansion when the sidebar menu opens a default-collapsed branch', async () => {
	const projectCollapse = createCollapseStore();
	const { container } = render(SidebarHost, {
		chats: [chat('parent'), delegated('child', 'parent')],
		projectCollapse,
		sidebarNestDelegatedChats: true,
		collapseDelegatedChatsByDefault: true,
		autoLoadSavedSearches: false,
	});
	const child = '[data-sidebar-virtual-row="child"]';
	expect(container.querySelector(child)).toBeNull();
	const parent = container.querySelector<HTMLElement>('[data-sidebar-virtual-row="parent"]')!;
	await fireEvent.click(within(parent).getByRole('button', { name: 'Chat actions' }));
	await fireEvent.click(await screen.findByRole('menuitem', { name: 'Expand delegated chats' }));
	expect(container.querySelector(child)).toBeTruthy();
	expect(projectCollapse.snapshot().expandedDelegationKeys).toEqual(['delegation:parent']);
});

it('clears an empty project group before another chat appears in that project', async () => {
	const removed = rosterEntry('removed');
	const projectKey = sidebarGroupCollapseKey(null, [
		['project', sidebarProjectKey(removed.projectPath)],
	]);
	const projectCollapse = createCollapseStore();
	const chatSessions = new ChatSessionsStore({
		listChats: async () => roster(removed),
	});
	render(SidebarHost, { chatSessions, projectCollapse, autoLoadSavedSearches: false });
	await chatSessions.refreshChats();
	projectCollapse.setCollapsed(projectKey, true);
	chatSessions.removeChat(removed.id);
	await tick();
	chatSessions.upsertFromServer([rosterEntry('replacement')]);
	await tick();
	expect(projectCollapse.isCollapsed(projectKey)).toBe(false);
});

it('leaves choices alone after a failed load and prunes only groups from a ready roster', async () => {
	const saved = {
		collapsedProjectKeys: [
			'delegation:parent',
			sidebarGroupCollapseKey(null, [['executor', 'local']]),
		],
		expandedDelegationKeys: ['delegation:other-parent'],
	};
	localStorage.setItem(LOCAL_STORAGE_KEYS.sidebarProjectCollapse, JSON.stringify(saved));
	const projectCollapse = createCollapseStore();
	const chatSessions = new ChatSessionsStore({
		listChats: vi.fn(async () => roster()).mockRejectedValueOnce(new Error('Offline')),
		notifyError: vi.fn(),
	});
	render(SidebarHost, { chatSessions, projectCollapse, autoLoadSavedSearches: false });
	await chatSessions.refreshChats();
	await tick();
	expect(chatSessions.chatListStatus).toBe('error');
	expect(projectCollapse.collapsedProjectKeys).toEqual(new Set(saved.collapsedProjectKeys));
	expect(projectCollapse.expandedDelegationKeys).toEqual(new Set(saved.expandedDelegationKeys));
	expect(JSON.parse(localStorage.getItem(LOCAL_STORAGE_KEYS.sidebarProjectCollapse)!)).toEqual(
		saved,
	);
	await chatSessions.refreshChats();
	await waitFor(() =>
		expect(projectCollapse.snapshot()).toEqual({
			collapsedProjectKeys: ['delegation:parent'],
			expandedDelegationKeys: saved.expandedDelegationKeys,
		}),
	);
});
