import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import SidebarHost from './SidebarHost.svelte';

import { getSavedSearches } from '$lib/api/settings';
import { createSidebarSearchStore } from '$lib/sidebar/search/sidebar-search-store.svelte.js';
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
		agentSettings: { ownerId: 'claude', schemaVersion: 1, values: {} },
		createdAt: '2025-01-01T00:00:00.000Z',
		lastActivityAt: '2025-01-01T00:00:00.000Z',
		lastReadAt: '2025-01-01T00:00:00.000Z',
		isPinned: false,
		isArchived: false,
		isProcessing: false,
		processingPhase: null,
		isUnread: false,
		canReloadFromNativeHistory: false,
		status: 'draft',
		lastMessage: `${title} preview`,
		tags: [],
		firstMessage: `${title} first`,
		...overrides,
		parentChat: overrides.parentChat ?? null,
		agentOwnershipEpoch: overrides.agentOwnershipEpoch ?? null,
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

	it('registers the chat list viewport as the primary scroll region', async () => {
		const { container } = render(SidebarHost, {
			chats: [createChat('chat-1', 'First chat')],
		});

		await waitFor(() => {
			expect(
				container.querySelector<HTMLElement>('[data-slot="scroll-area-viewport"]')?.dataset
					.workspaceScrollRegion,
			).toBe('primary');
		});
	});

	it('revalidates an activity-only mutation without restarting page zero', async () => {
		let chats = [createChat('chat-1', 'Transcript result')];
		const refreshTranscriptSearch = vi.fn(async () => {});
		const scheduleTranscriptSearchRevalidation = vi.fn();
		const sidebarSearch = createSidebarSearchStore({
			getTranscriptSearchEnabled: () => true,
			getSearchResultSort: () => 'activity',
			getChats: () => chats,
			getSelectedChatId: () => null,
			notifyError: vi.fn(),
		});
		sidebarSearch.searchDialogOpen = true;
		sidebarSearch.draftQuery = 'needle';
		sidebarSearch.transcriptSearchQuery = 'needle';
		sidebarSearch.transcriptSearchPage = {
			offset: 400,
			limit: 100,
			total: 600,
			hasMore: true,
			nextOffset: 500,
		};
		sidebarSearch.refreshTranscriptSearch = refreshTranscriptSearch;
		sidebarSearch.scheduleTranscriptSearchRevalidation = scheduleTranscriptSearchRevalidation;
		const view = render(SidebarHost, {
			chats,
			sidebarSearch,
			sidebarSearchResultSort: 'activity',
			autoLoadSavedSearches: false,
		});
		await waitFor(() => expect(refreshTranscriptSearch).toHaveBeenCalledTimes(1));
		refreshTranscriptSearch.mockClear();
		scheduleTranscriptSearchRevalidation.mockClear();

		chats = [{ ...chats[0], lastActivityAt: '2025-02-01T00:00:00.000Z' }];
		await view.rerender({
			chats,
			sidebarSearch,
			sidebarSearchResultSort: 'activity',
			autoLoadSavedSearches: false,
		});

		await waitFor(() => expect(scheduleTranscriptSearchRevalidation).toHaveBeenCalledTimes(1));
		expect(refreshTranscriptSearch).not.toHaveBeenCalled();
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

	it('switches chat grouping from the sidebar actions menu', async () => {
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

		const projectGrouping = await screen.findByRole('menuitemradio', {
			name: 'Project',
		});
		expect(projectGrouping.getAttribute('aria-checked')).toBe('true');
		const noGrouping = screen.getByRole('menuitemradio', { name: 'No grouping' });
		expect(noGrouping.getAttribute('aria-checked')).toBe('false');

		await fireEvent.click(noGrouping);

		await waitFor(() => {
			expect(document.querySelector('[data-sidebar-project-header="/tmp/project-a"]')).toBeNull();
		});
	});

	it('groups inactive and archived chats by project activity from the sidebar actions menu', async () => {
		render(SidebarHost, {
			chats: [
				createChat('chat-active', 'Active chat', {
					status: 'running',
					projectPath: '/tmp/project-a',
				}),
				createChat('chat-inactive', 'Inactive chat', {
					status: 'running',
					projectPath: '/tmp/project-b',
					createdAt: '2024-12-20T00:00:00.000Z',
					lastActivityAt: '2024-12-20T00:00:00.000Z',
				}),
				createChat('chat-archived', 'Archived chat', {
					status: 'running',
					projectPath: '/tmp/project-a',
					isArchived: true,
				}),
			],
			autoLoadSavedSearches: false,
		});

		expect(document.querySelector('[data-sidebar-section-header="inactive"]')).toBeNull();

		const [menuTrigger] = screen.getAllByRole('button', { name: 'More actions' });
		await fireEvent.click(menuTrigger);

		const projectAndActivity = await screen.findByRole('menuitemradio', {
			name: 'Project and activity',
		});
		expect(projectAndActivity.getAttribute('aria-checked')).toBe('false');

		await fireEvent.click(projectAndActivity);

		await waitFor(() => {
			expect(document.querySelector('[data-sidebar-section-header="inactive"]')).toBeTruthy();
		});
		expect(document.querySelector('[data-sidebar-section-header="archived"]')).toBeTruthy();
		expect(screen.getByText('Inactive')).toBeTruthy();

		const [menuTriggerAgain] = screen.getAllByRole('button', { name: 'More actions' });
		await fireEvent.click(menuTriggerAgain);
		const activity = await screen.findByRole('menuitemradio', {
			name: 'Activity',
		});
		await fireEvent.click(activity);

		await waitFor(() => {
			expect(document.querySelector('[data-sidebar-section-header="active"]')).toBeTruthy();
		});
		expect(document.querySelector('[data-sidebar-project-header="/tmp/project-a"]')).toBeNull();
		expect(screen.getByText('Active')).toBeTruthy();
	});

	it('uses the configured inactivity duration for project activity grouping', async () => {
		const chats = [
			createChat('chat-recent', 'Recently active chat', {
				status: 'running',
				projectPath: '/tmp/project-a',
				createdAt: '2024-12-27T00:00:00.000Z',
				lastActivityAt: '2024-12-27T00:00:00.000Z',
			}),
		];
		const view = render(SidebarHost, {
			chats,
			autoLoadSavedSearches: false,
			sidebarGrouping: 'project-and-activity',
			sidebarInactivityDuration: '2-weeks',
		});

		expect(document.querySelector('[data-sidebar-project-header="/tmp/project-a"]')).toBeTruthy();
		expect(document.querySelector('[data-sidebar-section-header="inactive"]')).toBeNull();

		await view.rerender({
			chats,
			autoLoadSavedSearches: false,
			sidebarGrouping: 'project-and-activity',
			sidebarInactivityDuration: '2-days',
		});

		await waitFor(() => {
			expect(document.querySelector('[data-sidebar-section-header="inactive"]')).toBeTruthy();
		});
		expect(document.querySelector('[data-sidebar-project-header="/tmp/project-a"]')).toBeNull();
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
			name: 'Combine nested paths',
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

	it('updates chat sidebar autohide and docking from the sidebar actions menu', async () => {
		render(SidebarHost, {
			autoLoadSavedSearches: false,
			chatListAutohideAvailable: true,
		});

		let [menuTrigger] = screen.getAllByRole('button', { name: 'More actions' });
		await fireEvent.click(menuTrigger);

		let autohideItem = await screen.findByRole('menuitemcheckbox', {
			name: 'Autohide sidebar',
		});
		expect(autohideItem.getAttribute('aria-checked')).toBe('false');
		await fireEvent.click(autohideItem);

		menuTrigger = screen.getAllByRole('button', { name: 'More actions' })[0];
		await fireEvent.click(menuTrigger);
		autohideItem = await screen.findByRole('menuitemcheckbox', {
			name: 'Autohide sidebar',
		});
		expect(autohideItem.getAttribute('aria-checked')).toBe('true');

		const dockItem = screen.getByRole('menuitemcheckbox', {
			name: 'Dock sidebar on the right',
		});
		expect(dockItem.getAttribute('aria-checked')).toBe('false');
		await fireEvent.click(dockItem);

		menuTrigger = screen.getAllByRole('button', { name: 'More actions' })[0];
		await fireEvent.click(menuTrigger);
		expect(
			(
				await screen.findByRole('menuitemcheckbox', { name: 'Dock sidebar on the right' })
			).getAttribute('aria-checked'),
		).toBe('true');
	});

	it('switches chat item layout from the sidebar actions menu', async () => {
		render(SidebarHost, {
			chats: [createChat('chat-1', 'First chat')],
			autoLoadSavedSearches: false,
		});

		expect(screen.getByText('First chat preview')).toBeTruthy();

		const [menuTrigger] = screen.getAllByRole('button', { name: 'More actions' });
		await fireEvent.click(menuTrigger);

		const defaultLayout = await screen.findByRole('menuitemradio', { name: 'Default' });
		expect(defaultLayout.getAttribute('aria-checked')).toBe('true');
		const compactLayout = screen.getByRole('menuitemradio', { name: 'Compact chat items' });
		expect(compactLayout.getAttribute('aria-checked')).toBe('false');

		await fireEvent.click(compactLayout);

		await waitFor(() => {
			expect(screen.queryByText('First chat preview')).toBeNull();
		});
		expect(screen.getByText('First chat')).toBeTruthy();
	});

	it('renders single-line chat items from the sidebar actions menu', async () => {
		render(SidebarHost, {
			chats: [createChat('chat-1', 'First chat')],
			autoLoadSavedSearches: false,
		});

		expect(screen.getByText('First chat preview')).toBeTruthy();

		const [menuTrigger] = screen.getAllByRole('button', { name: 'More actions' });
		await fireEvent.click(menuTrigger);

		const singleLineLayout = await screen.findByRole('menuitemradio', {
			name: 'Single-line chat items',
		});
		expect(singleLineLayout.getAttribute('aria-checked')).toBe('false');

		await fireEvent.click(singleLineLayout);

		await waitFor(() => {
			expect(document.querySelector('[data-slot="sidebar-chat-timestamp-badge"]')).toBeTruthy();
		});
		expect(screen.queryByText('First chat preview')).toBeNull();
		expect(screen.getByText('First chat')).toBeTruthy();
	});

	it('marks the sidebar to suppress activity animation when motion is reduced', () => {
		render(SidebarHost, {
			chats: [createChat('chat-a', 'Chat A', { isProcessing: true })],
			reduceMotion: true,
		});

		expect(document.querySelector('[data-slot="sidebar"]')?.className).toContain(
			'sidebar-reduce-motion',
		);
		const processingIndicator = document.querySelector(
			'[data-slot="sidebar-chat-processing-indicator"]',
		);
		expect(processingIndicator).toBeTruthy();
		expect(processingIndicator?.closest('.sidebar-reduce-motion')).toBeTruthy();
	});
});
