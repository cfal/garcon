import { describe, expect, it } from 'vitest';

import { SidebarFilterState } from '../sidebar-filter-state.svelte';
import type { ChatSessionRecord } from '$lib/types/chat-session';

function makeChat(overrides: Partial<ChatSessionRecord>): ChatSessionRecord {
	return {
		id: 'chat-1',
		projectPath: '/workspace/project',
		title: 'Unread ops chat',
		provider: 'claude',
		model: 'sonnet',
		permissionMode: 'default',
		thinkingMode: 'none',
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
			tags: ['ops'],
			providers: [],
			models: [],
			status: 'unread',
		});
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
					providers: [],
					models: [],
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
			providers: [],
			models: [],
			status: 'unread',
		});
	});

	describe('activeFilterChips', () => {
		it('is empty when no filters applied (all folder, no search)', () => {
			const chats = [makeChat({ id: 'chat-1' })];
			const state = new SidebarFilterState({
				get chats() {
					return chats;
				},
			});

			state.selectFolder('all');
			state.searchQuery = '';

			expect(state.activeFilterChips).toEqual([]);
		});

		it('shows folder-contributed tags as non-removable', () => {
			const chats = [makeChat({ id: 'chat-1', tags: ['ops'] })];
			const state = new SidebarFilterState({
				get chats() {
					return chats;
				},
			});

			state.setUserFolders([
				{
					id: 'folder-ops',
					name: 'Ops',
					filter: { textTokens: [], tags: ['ops'], providers: [], models: [] },
					createdAt: '2026-03-27T00:00:00.000Z',
				},
			]);
			state.selectFolder('folder-ops');

			const tagChips = state.activeFilterChips.filter((c) => c.type === 'tag');
			expect(tagChips).toHaveLength(1);
			expect(tagChips[0].value).toBe('ops');
			expect(tagChips[0].removable).toBe(false);
		});

		it('shows search-contributed tags as removable', () => {
			const chats = [makeChat({ id: 'chat-1', tags: ['ops'] })];
			const state = new SidebarFilterState({
				get chats() {
					return chats;
				},
			});

			state.selectFolder('all');
			state.searchQuery = 'tag:ops';

			const tagChips = state.activeFilterChips.filter((c) => c.type === 'tag');
			expect(tagChips).toHaveLength(1);
			expect(tagChips[0].value).toBe('ops');
			expect(tagChips[0].removable).toBe(true);
		});

		it('includes status chip from folder filter', () => {
			const chats = [makeChat({ id: 'chat-1', isUnread: true })];
			const state = new SidebarFilterState({
				get chats() {
					return chats;
				},
			});

			state.selectFolder('unread');

			const statusChips = state.activeFilterChips.filter((c) => c.type === 'status');
			expect(statusChips).toHaveLength(1);
			expect(statusChips[0].value).toBe('unread');
			expect(statusChips[0].removable).toBe(false);
		});

		it('mixed folder + search produces correct removable/non-removable mix', () => {
			const chats = [makeChat({ id: 'chat-1', tags: ['ops', 'bugs'] })];
			const state = new SidebarFilterState({
				get chats() {
					return chats;
				},
			});

			state.setUserFolders([
				{
					id: 'folder-ops',
					name: 'Ops',
					filter: { textTokens: [], tags: ['ops'], providers: [], models: [] },
					createdAt: '2026-03-27T00:00:00.000Z',
				},
			]);
			state.selectFolder('folder-ops');
			state.searchQuery = 'tag:bugs';

			const tagChips = state.activeFilterChips.filter((c) => c.type === 'tag');
			expect(tagChips).toHaveLength(2);

			const opsChip = tagChips.find((c) => c.value === 'ops');
			const bugsChip = tagChips.find((c) => c.value === 'bugs');
			expect(opsChip?.removable).toBe(false);
			expect(bugsChip?.removable).toBe(true);
		});
	});
});
