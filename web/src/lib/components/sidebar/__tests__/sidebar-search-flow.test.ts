import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import SidebarHost from './SidebarHost.svelte';

import { getSavedSearches } from '$lib/api/settings';
import type { ChatSessionRecord } from '$lib/types/chat-session';

vi.mock('$lib/api/settings', async () => {
	const actual = await vi.importActual<typeof import('$lib/api/settings')>('$lib/api/settings');
	return {
		...actual,
		getSavedSearches: vi.fn(),
		createSavedSearch: vi.fn(),
		updateSavedSearch: vi.fn(),
		deleteSavedSearch: vi.fn(),
		reorderSavedSearches: vi.fn(),
	};
});

function createChat(
	id: string,
	title: string,
	overrides: Partial<ChatSessionRecord> = {},
): ChatSessionRecord {
	return {
		id,
		projectPath: '/tmp/project',
		effectiveProjectKey: '/tmp/project',
		projectIdentityState: 'available',
		orderGroup: 'normal',
		title,
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
		lastMessage: `${title} preview`,
		tags: [],
		firstMessage: `${title} first`,
		...overrides,
	};
}

describe('sidebar search dialog flow', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(getSavedSearches).mockResolvedValue({ savedSearches: [] });
	});

	afterEach(() => {
		cleanup();
	});

	it('restores the search dialog draft after cancelling add saved search', async () => {
		render(SidebarHost, {
			chats: [createChat('chat-1', 'First chat')],
		});

		await waitFor(() => {
			expect(getSavedSearches).toHaveBeenCalledTimes(1);
		});

		await fireEvent.click(await screen.findByRole('button', { name: 'Search chats...' }));

		const searchInput = await screen.findByRole('textbox');
		await fireEvent.input(searchInput, { target: { value: 'tag:ops' } });
		await fireEvent.click(screen.getByRole('button', { name: 'Add saved search' }));

		const editorQueryInput = await screen.findByLabelText('Query');
		expect((editorQueryInput as HTMLInputElement).value).toBe('tag:ops');

		await fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

		const resumedInput = await screen.findByRole('textbox');
		expect((resumedInput as HTMLInputElement).value).toBe('tag:ops');
		expect(screen.getByRole('button', { name: 'Manage searches' })).toBeTruthy();
	});

	it('notifies when saved searches fail to load', async () => {
		const notifications = { error: vi.fn(), info: vi.fn() };
		vi.mocked(getSavedSearches).mockRejectedValue(new Error('network'));

		render(SidebarHost, {
			chats: [createChat('chat-1', 'First chat')],
			notifications,
		});

		await waitFor(() => {
			expect(notifications.error).toHaveBeenCalledWith('Failed to load saved searches.');
		});
	});

	it('toggles project grouping from the sidebar actions menu', async () => {
		render(SidebarHost, {
			chats: [
				createChat('chat-a', 'Project B chat', { projectPath: '/tmp/project-b' }),
				createChat('chat-b', 'Project A chat', { projectPath: '/tmp/project-a' }),
			],
			autoLoadSavedSearches: false,
		});

		expect(document.querySelector('[data-sidebar-project-header="/tmp/project-a"]')).toBeTruthy();

		const [menuTrigger] = screen.getAllByRole('button', { name: 'More actions' });
		await fireEvent.click(menuTrigger);

		const groupByProjectItem = await screen.findByRole('menuitemcheckbox', {
			name: 'Group chats by project',
		});
		expect(groupByProjectItem.getAttribute('aria-checked')).toBe('true');

		await fireEvent.click(groupByProjectItem);

		await waitFor(() => {
			expect(document.querySelector('[data-sidebar-project-header="/tmp/project-a"]')).toBeNull();
		});
	});

	it('toggles nested project grouping from the sidebar actions menu when project grouping is enabled', async () => {
		render(SidebarHost, {
			chats: [
				createChat('chat-a', 'Root chat', { projectPath: '/tmp/project' }),
				createChat('chat-b', 'Nested chat', { projectPath: '/tmp/project/packages/app' }),
			],
			autoLoadSavedSearches: false,
		});

		expect(document.querySelector('[data-sidebar-project-header="/tmp/project"]')).toBeTruthy();
		expect(
			document.querySelector('[data-sidebar-project-header="/tmp/project/packages/app"]'),
		).toBeTruthy();

		const [menuTrigger] = screen.getAllByRole('button', { name: 'More actions' });
		await fireEvent.click(menuTrigger);

		const nestedProjectItem = await screen.findByRole('menuitemcheckbox', {
			name: 'Group nested project paths',
		});
		expect(nestedProjectItem.getAttribute('aria-checked')).toBe('false');

		await fireEvent.click(nestedProjectItem);

		await waitFor(() => {
			expect(
				document.querySelector('[data-sidebar-project-header="/tmp/project/packages/app"]'),
			).toBeNull();
		});
		expect(document.querySelector('[data-sidebar-project-header="/tmp/project"]')).toBeTruthy();
		expect(screen.getByTitle('/tmp/project/packages/app')).toBeTruthy();
	});

	it('toggles compact chat items from the sidebar actions menu', async () => {
		render(SidebarHost, {
			chats: [createChat('chat-1', 'First chat')],
			autoLoadSavedSearches: false,
		});

		expect(screen.getByText('First chat preview')).toBeTruthy();

		const [menuTrigger] = screen.getAllByRole('button', { name: 'More actions' });
		await fireEvent.click(menuTrigger);

		const compactChatItems = await screen.findByRole('menuitemcheckbox', {
			name: 'Compact chat items',
		});
		expect(compactChatItems.getAttribute('aria-checked')).toBe('false');

		await fireEvent.click(compactChatItems);

		await waitFor(() => {
			expect(screen.queryByText('First chat preview')).toBeNull();
		});
	});
});
