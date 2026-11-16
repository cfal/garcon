import { cleanup, render, waitFor } from '@testing-library/svelte';
import { tick } from 'svelte';
import { afterEach, expect, it, vi } from 'vitest';
import { ChatSessionsStore } from '$lib/chat/sessions/chat-sessions.svelte';
import { SidebarProjectCollapseStore } from '$lib/sidebar/projects/sidebar-project-collapse.svelte';
import { sidebarGroupCollapseKey } from '$lib/sidebar/display/sidebar-row-model';
import { LOCAL_STORAGE_KEYS } from '$lib/utils/local-persistence';
import SidebarHost from './SidebarHost.svelte';

afterEach(() => {
	cleanup();
	localStorage.removeItem(LOCAL_STORAGE_KEYS.sidebarProjectCollapse);
});

it('preserves collapse persistence after initial load failure, then prunes an authoritative empty roster', async () => {
	const saved = {
		collapsedProjectKeys: [
			'delegation:parent',
			sidebarGroupCollapseKey(null, [['executor', 'local']]),
		],
	};
	localStorage.setItem(LOCAL_STORAGE_KEYS.sidebarProjectCollapse, JSON.stringify(saved));
	const projectCollapse = new SidebarProjectCollapseStore();
	const listChats = vi
		.fn<
			NonNullable<
				import('$lib/chat/sessions/chat-sessions-contract').ChatSessionsStoreDeps['listChats']
			>
		>()
		.mockRejectedValueOnce(new Error('Offline'))
		.mockResolvedValue({ sessions: [], total: 0, lastSelectedChatId: null });
	const chatSessions = new ChatSessionsStore({ listChats, notifyError: vi.fn() });
	try {
		render(SidebarHost, { chatSessions, projectCollapse, autoLoadSavedSearches: false });
		await chatSessions.refreshChats();
		await tick();
		expect(chatSessions.chatListStatus).toBe('error');
		expect(projectCollapse.collapsedProjectKeys).toEqual(new Set(saved.collapsedProjectKeys));
		expect(JSON.parse(localStorage.getItem(LOCAL_STORAGE_KEYS.sidebarProjectCollapse)!)).toEqual(
			saved,
		);
		await chatSessions.refreshChats();
		await waitFor(() => expect(projectCollapse.collapsedProjectKeys.size).toBe(0));
	} finally {
		projectCollapse.destroy();
	}
});
