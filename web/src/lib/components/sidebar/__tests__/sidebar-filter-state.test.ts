import { describe, expect, it } from 'vitest';

import { SidebarFilterState } from '../sidebar-filter-state.svelte';
import type { ChatSessionRecord } from '$lib/types/chat-session';

function makeChat(overrides: Partial<ChatSessionRecord>): ChatSessionRecord {
	return {
		id: 'chat-1',
		projectPath: '/workspace/project',
		title: 'Unread ops chat',
		agentId: 'claude',
		model: 'sonnet',
		permissionMode: 'default',
		thinkingMode: 'none',
		claudeThinkingMode: 'auto',
		ampAgentMode: 'smart' as const,
		createdAt: null,
		lastActivityAt: '2026-03-27T08:00:00.000Z',
		lastReadAt: null,
		isPinned: false,
		isArchived: false,
		isProcessing: false,
		isUnread: false,
		status: 'running',
		tags: [],
		...overrides,
	};
}

describe('SidebarFilterState', () => {
	it('builds a saveable filter from unread plus search state', () => {
		const chats = [
			makeChat({ id: 'chat-1', isUnread: true, tags: ['ops'] }),
			makeChat({ id: 'chat-2', title: 'Read chat', isUnread: false, tags: ['ops'] }),
		];
		const state = new SidebarFilterState({
			get chats() {
				return chats;
			},
		});

		state.selectFolder('unread');
		state.searchQuery = 'tag:ops';

		expect(state.canSaveCurrentFilter).toBe(true);
		expect(state.currentFilter).toEqual({
			textTokens: [],
			tags: [['ops']],
			agents: [],
			models: [],
			project: [],
			status: 'unread',
		});
		expect(state.filteredChats.map((chat) => chat.id)).toEqual(['chat-1']);
	});

	it('merges tag OR groups from search with folder filter', () => {
		const chats = [
			makeChat({ id: 'chat-1', isUnread: true, tags: ['ops', 'bug'] }),
			makeChat({ id: 'chat-2', isUnread: true, tags: ['dev'] }),
		];
		const state = new SidebarFilterState({
			get chats() { return chats; },
		});

		state.selectFolder('unread');
		state.searchQuery = 'tag:ops|bug';

		expect(state.canSaveCurrentFilter).toBe(true);
		expect(state.currentFilter.tags).toEqual([['ops', 'bug']]);
		expect(state.filteredChats.map((chat) => chat.id)).toEqual(['chat-1']);
	});

	it('applies saved folder status filters like system folders', () => {
		const chats = [
			makeChat({ id: 'chat-1', isProcessing: true }),
			makeChat({ id: 'chat-2', isProcessing: false }),
		];
		const state = new SidebarFilterState({
			get chats() {
				return chats;
			},
		});

		state.setUserFolders([
			{
				id: 'folder-active',
				name: 'Busy chats',
				filter: {
					textTokens: [],
					tags: [],
					agents: [],
					models: [],
					project: [],
					status: 'active',
				},
				createdAt: '2026-03-27T00:00:00.000Z',
			},
		]);
		state.selectFolder('folder-active');

		expect(state.filteredChats.map((chat) => chat.id)).toEqual(['chat-1']);
	});

	it('treats a status-only system folder as saveable', () => {
		const chats = [makeChat({ id: 'chat-1', isUnread: true })];
		const state = new SidebarFilterState({
			get chats() {
				return chats;
			},
		});

		state.selectFolder('unread');

		expect(state.canSaveCurrentFilter).toBe(true);
		expect(state.currentFilter).toEqual({
			textTokens: [],
			tags: [],
			agents: [],
			models: [],
			project: [],
			status: 'unread',
		});
	});

});
