import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import MobileSidebarLifecycleHost from './MobileSidebarLifecycleHost.svelte';

import { getSavedSearches, type SavedChatSearch } from '$lib/api/settings';
import { createSidebarSearchStore } from '$lib/stores/sidebar-search.svelte';
import type { ChatSessionRecord } from '$lib/types/chat-session';

vi.mock('$lib/api/settings', async () => {
	const actual = await vi.importActual<typeof import('$lib/api/settings')>('$lib/api/settings');
	return {
		...actual,
		getSavedSearches: vi.fn(),
	};
});

function createChat(overrides: Partial<ChatSessionRecord>): ChatSessionRecord {
	return {
		id: 'chat-1',
		projectPath: '/tmp/project',
		effectiveProjectKey: '/tmp/project',
		projectIdentityState: 'available',
		orderGroup: 'normal',
		title: 'Chat',
		agentId: 'claude',
		model: 'sonnet',
		permissionMode: 'default',
		thinkingMode: 'low',
		claudeThinkingMode: 'auto',
		ampAgentMode: 'smart',
		createdAt: '2025-01-01T00:00:00.000Z',
		lastActivityAt: '2025-01-01T00:00:00.000Z',
		lastReadAt: '2025-01-01T00:00:00.000Z',
		isPinned: false,
		isArchived: false,
		isProcessing: false,
		isUnread: false,
		status: 'draft',
		lastMessage: 'Preview',
		tags: [],
		firstMessage: 'First',
		...overrides,
	};
}

function createSavedSearch(id: string, title: string, query: string): SavedChatSearch {
	return {
		id,
		title,
		query,
		showAsSidebarPill: true,
		showInSidebarMenu: true,
		showInSearchDialog: true,
		createdAt: '2026-03-27T00:00:00.000Z',
		updatedAt: '2026-03-27T00:00:00.000Z',
	};
}

describe('mobile sidebar lifecycle', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(getSavedSearches).mockResolvedValue({
			savedSearches: [createSavedSearch('unread', 'Unread', 'status:unread')],
		});
	});

	afterEach(async () => {
		cleanup();
		await new Promise((resolve) => window.setTimeout(resolve, 30));
	});

	it('preserves the active saved-search pill across drawer close and reopen', async () => {
		render(MobileSidebarLifecycleHost, {
			chats: [
				createChat({ id: 'unread-chat', title: 'Unread chat', isUnread: true }),
				createChat({ id: 'read-chat', title: 'Read chat', isUnread: false }),
			],
		});

		const pill = await screen.findByRole('button', { name: 'Unread' });
		await fireEvent.click(pill);

		expect(screen.getByRole('button', { name: 'Unread' }).getAttribute('aria-pressed')).toBe(
			'true',
		);
		expect(screen.getByText('Unread chat')).toBeTruthy();
		expect(screen.queryByText('Read chat')).toBeNull();

		await fireEvent.click(screen.getByRole('button', { name: 'Close sidebar' }));
		expect(screen.queryByRole('button', { name: 'Unread' })).toBeNull();

		await fireEvent.click(screen.getByRole('button', { name: 'Open sidebar' }));

		const reopenedPill = await screen.findByRole('button', { name: 'Unread' });
		expect(reopenedPill.getAttribute('aria-pressed')).toBe('true');
		expect(screen.getByText('Unread chat')).toBeTruthy();
		expect(screen.queryByText('Read chat')).toBeNull();
		expect(getSavedSearches).toHaveBeenCalledTimes(1);
	});

	it('renders preloaded saved-search pills immediately when the drawer opens', async () => {
		const injectedGetSavedSearches = vi.fn().mockResolvedValue({ savedSearches: [] });
		const chats = [createChat({ id: 'unread-chat', title: 'Unread chat', isUnread: true })];
		const sidebarSearch = createSidebarSearchStore({
			getChats: () => chats,
			getSelectedChatId: () => null,
			notifyError: vi.fn(),
			getSavedSearches: injectedGetSavedSearches,
		});
		sidebarSearch.setSavedSearches([createSavedSearch('unread', 'Unread', 'status:unread')]);

		render(MobileSidebarLifecycleHost, {
			chats,
			sidebarSearch,
			initialOpen: false,
		});

		await fireEvent.click(screen.getByRole('button', { name: 'Open sidebar' }));

		expect(screen.getByRole('button', { name: 'Unread' })).toBeTruthy();
		await waitFor(() => {
			expect(injectedGetSavedSearches).not.toHaveBeenCalled();
		});
	});
});
