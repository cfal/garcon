import { migrateSidebarGrouping } from '$lib/sidebar/display/sidebar-preferences';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import SidebarHost from './SidebarHost.svelte';
import { localExecutor, remoteExecutor } from '$lib/executors/__tests__/fixtures';

import { getSavedSearches } from '$lib/api/settings';
import { createSidebarSearchStore } from '$lib/sidebar/search/sidebar-search-store.svelte.js';
import type { ChatSessionRecord } from '$lib/chat/sessions/chat-session-types';
import {
	installResizeObserverHarness,
	ResizeObserverHarness,
} from '$lib/components/shared/__tests__/resize-observer-harness.js';

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

	it('starts a project chat without toggling its collapsed group', async () => {
		const onNewProjectChat = vi.fn();
		const { container } = render(SidebarHost, {
			onNewProjectChat,
			autoLoadSavedSearches: false,
			chats: [createChat('chat-1', 'First chat')],
			collapsedProjectKeys: new Set(['path:/tmp/project']),
		});
		await fireEvent.click(await screen.findByRole('button', { name: 'New chat in /tmp/project' }));
		expect(onNewProjectChat).toHaveBeenCalledExactlyOnceWith({
			executorId: 'local',
			projectPath: '/tmp/project',
		});
		expect(
			container.querySelector('[data-sidebar-project-collapsed]')?.getAttribute('aria-expanded'),
		).toBe('false');
		expect(screen.getByRole('heading', { name: 'project 1' })).toBeTruthy();
	});

	it('keeps identical project paths on different executors distinct', async () => {
		const onNewProjectChat = vi.fn();
		render(SidebarHost, {
			onNewProjectChat,
			autoLoadSavedSearches: false,
			executors: [localExecutor, remoteExecutor],
			chats: [
				createChat('local-chat', 'Local chat'),
				createChat('remote-chat', 'Remote chat', { executorId: remoteExecutor.id }),
			],
		});
		await fireEvent.click(
			await screen.findByRole('button', { name: 'New chat in Worker: /tmp/project' }),
		);
		expect(onNewProjectChat).toHaveBeenLastCalledWith({
			executorId: remoteExecutor.id,
			projectPath: '/tmp/project',
		});
		await fireEvent.click(screen.getByRole('button', { name: 'New chat in /tmp/project' }));
		expect(onNewProjectChat).toHaveBeenLastCalledWith({
			executorId: 'local',
			projectPath: '/tmp/project',
		});
	});

	it.each(['none', 'activity', 'status'] as const)(
		'omits project actions in %s grouping',
		(sidebarGrouping) => {
			render(SidebarHost, {
				chats: [createChat('chat-1', 'First chat')],
				sidebarGrouping,
				autoLoadSavedSearches: false,
			});
			expect(screen.queryByRole('button', { name: /^New chat in / })).toBeNull();
		},
	);

	it('uses the displayed parent folder when nested projects are combined', async () => {
		const onNewProjectChat = vi.fn();
		render(SidebarHost, {
			onNewProjectChat,
			autoLoadSavedSearches: false,
			sidebarGroupNestedProjectPaths: true,
			chats: [
				createChat('parent', 'Parent'),
				createChat('child', 'Child', { projectPath: '/tmp/project/child' }),
			],
		});
		await fireEvent.click(await screen.findByRole('button', { name: 'New chat in /tmp/project' }));
		expect(onNewProjectChat).toHaveBeenCalledWith({
			executorId: 'local',
			projectPath: '/tmp/project',
		});
		expect(screen.getAllByRole('button', { name: /^New chat in / })).toHaveLength(1);
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
		await new Promise((resolve) => setTimeout(resolve, 200));
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

	it('applies grouping changes only when the display dialog is accepted', async () => {
		render(SidebarHost, {
			chats: [
				createChat('chat-a', 'Project B chat', { projectPath: '/tmp/project-b' }),
				createChat('chat-b', 'Project A chat', { projectPath: '/tmp/project-a' }),
			],
			autoLoadSavedSearches: false,
		});
		await openDisplay();
		await fireEvent.click(screen.getByRole('checkbox', { name: 'Project path' }));
		expect(document.querySelector('[data-sidebar-project-header="/tmp/project-a"]')).toBeTruthy();
		await fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
		await waitFor(() =>
			expect(document.querySelector('[data-sidebar-project-header="/tmp/project-a"]')).toBeNull(),
		);
	});

	it.each([false, true])('restores display dialog focus (mobile=%s)', async (isMobile) => {
		render(SidebarHost, { isMobile, autoLoadSavedSearches: false });
		const trigger = screen.getAllByRole('button', { name: 'More actions' })[0];
		for (const action of ['Apply', 'Cancel', 'Close', 'Escape']) {
			trigger.focus();
			await openDisplay();
			const checkbox = screen.getByRole('checkbox', { name: 'Project path' });
			checkbox.focus();
			if (action === 'Escape') await fireEvent.keyDown(checkbox, { key: 'Escape' });
			else await fireEvent.click(screen.getByRole('button', { name: action, exact: true }));
			await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
			await waitFor(() => expect(document.activeElement).toBe(trigger));
		}
	});

	it('composes activity and project fields without the retired preset', async () => {
		render(SidebarHost, {
			chats: [
				createChat('active', 'Active chat', { status: 'running' }),
				createChat('inactive', 'Inactive chat', {
					status: 'running',
					createdAt: '2024-12-20T00:00:00Z',
					lastActivityAt: '2024-12-20T00:00:00Z',
				}),
				createChat('archived', 'Archived chat', { status: 'running', isArchived: true }),
			],
			autoLoadSavedSearches: false,
		});
		await openDisplay();
		await fireEvent.click(screen.getByRole('checkbox', { name: 'Activity' }));
		await fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
		await waitFor(() =>
			expect(document.querySelector('[data-sidebar-section-header="inactive"]')).toBeTruthy(),
		);
		expect(document.querySelector('[data-sidebar-section-header="archived"]')).toBeTruthy();
		expect(document.querySelector('[data-sidebar-project-header]')).toBeTruthy();
	});

	it('groups chats by their own processing and unread state', async () => {
		render(SidebarHost, {
			chats: [
				createChat('processing', 'Processing chat', {
					isProcessing: true,
					processingPhase: 'running',
				}),
				createChat('unread', 'Unread chat', { isUnread: true }),
				createChat('caught-up', 'Caught up chat'),
			],
			autoLoadSavedSearches: false,
		});
		await openDisplay();
		await fireEvent.click(screen.getByRole('checkbox', { name: 'Project path' }));
		await fireEvent.click(screen.getByRole('checkbox', { name: 'Status' }));
		await fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
		await waitFor(() =>
			expect(
				Array.from(document.querySelectorAll('[data-sidebar-section-header]')).map((header) =>
					header.getAttribute('data-sidebar-section-header'),
				),
			).toEqual(['in-progress', 'ready-for-review', 'caught-up']),
		);
		expect(document.querySelector('[data-sidebar-project-header]')).toBeNull();
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
			sidebarGroupingFields: migrateSidebarGrouping('project-and-activity'),
			sidebarInactivityDuration: '2-weeks',
		});

		expect(document.querySelector('[data-sidebar-project-header="/tmp/project-a"]')).toBeTruthy();
		expect(document.querySelector('[data-sidebar-section-header="inactive"]')).toBeNull();

		await view.rerender({
			chats,
			autoLoadSavedSearches: false,
			sidebarGroupingFields: migrateSidebarGrouping('project-and-activity'),
			sidebarInactivityDuration: '2-days',
		});

		await waitFor(() => {
			expect(document.querySelector('[data-sidebar-section-header="inactive"]')).toBeTruthy();
		});
		expect(document.querySelector('[data-sidebar-project-header="/tmp/project-a"]')).toBeTruthy();
	});

	it('combines known project ancestors through the display dialog', async () => {
		render(SidebarHost, {
			chats: [
				createChat('root', 'Root chat', { projectPath: '/tmp/project' }),
				createChat('nested', 'Nested chat', { projectPath: '/tmp/project/packages/app' }),
			],
			autoLoadSavedSearches: false,
		});
		await openDisplay();
		await fireEvent.click(screen.getByRole('checkbox', { name: 'Combine nested paths' }));
		await fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
		await waitFor(() =>
			expect(
				document.querySelector('[data-sidebar-project-header="/tmp/project/packages/app"]'),
			).toBeNull(),
		);
		expect(document.querySelector('[data-sidebar-project-header="/tmp/project"]')).toBeTruthy();
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

	it('applies compact row appearance from the display dialog', async () => {
		render(SidebarHost, {
			chats: [createChat('chat-1', 'First chat')],
			autoLoadSavedSearches: false,
		});
		expect(screen.getByText('First chat preview')).toBeTruthy();
		await openDisplay();
		await fireEvent.click(screen.getByRole('radio', { name: 'Compact' }));
		await fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
		await waitFor(() => expect(screen.queryByText('First chat preview')).toBeNull());
		expect(screen.getByText('First chat')).toBeTruthy();
	});

	it('applies single-line row appearance from the display dialog', async () => {
		render(SidebarHost, {
			chats: [createChat('chat-1', 'First chat')],
			autoLoadSavedSearches: false,
		});
		await openDisplay();
		await fireEvent.click(screen.getByRole('radio', { name: 'Single-line' }));
		await fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
		await waitFor(() =>
			expect(document.querySelector('[data-slot="sidebar-chat-timestamp-badge"]')).toBeTruthy(),
		);
		expect(screen.queryByText('First chat preview')).toBeNull();
	});

	it.each(['none', 'project', 'project-and-activity', 'activity', 'status'] as const)(
		'toggles the project line without changing layout or %s grouping',
		async (sidebarGrouping) => {
			render(SidebarHost, {
				chats: [createChat('chat-1', 'First chat')],
				sidebarGroupingFields: migrateSidebarGrouping(sidebarGrouping),
				sidebarChatItemLayout: 'single-line',
				autoLoadSavedSearches: false,
			});

			const summary = document.querySelector('[data-slot="sidebar-chat-summary"]');
			expect(summary?.querySelector('[data-slot="chat-project-path"]')).toBeNull();
			for (const enabled of [true, false]) {
				await openDisplay();
				await fireEvent.click(screen.getByRole('checkbox', { name: 'Show project path' }));
				await fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
				await waitFor(() => {
					expect(Boolean(summary?.querySelector('[data-slot="chat-project-path"]'))).toBe(enabled);
				});
				expect(summary?.getAttribute('data-layout')).toBe('single-line');
			}
		},
	);

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

describe('sidebar back-to-top control', () => {
	let restoreResizeObserver: () => void;

	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(getSavedSearches).mockResolvedValue({ savedSearches: [] });
		restoreResizeObserver = installResizeObserverHarness();
	});

	afterEach(() => {
		cleanup();
		restoreResizeObserver();
	});

	it('returns the scroll viewport to the top without losing keyboard focus', async () => {
		const chats = Array.from({ length: 20 }, (_, index) =>
			createChat(`chat-${index}`, `Chat ${index}`),
		);
		const { container } = render(SidebarHost, {
			chats,
			isMobile: true,
			autoLoadSavedSearches: false,
		});
		const viewport = container.querySelector<HTMLElement>('[data-slot="scroll-area-viewport"]');
		if (!viewport) throw new Error('Expected the sidebar scroll viewport');

		Object.defineProperty(viewport, 'clientHeight', { configurable: true, value: 400 });
		const scrollTo = vi.fn((options: ScrollToOptions) => {
			viewport.scrollTop = options.top ?? viewport.scrollTop;
			viewport.dispatchEvent(new Event('scroll'));
		});
		Object.defineProperty(viewport, 'scrollTo', { configurable: true, value: scrollTo });

		viewport.scrollTop = 401;
		await fireEvent.scroll(viewport);
		const button = await screen.findByRole('button', { name: 'Back to top' });
		expect(button.className).toContain('min-h-11');
		expect(button.className).toContain('dark:bg-card');
		expect(button.className).not.toContain('bg-input');
		expect(viewport.getAttribute('role')).toBe('region');
		expect(viewport.getAttribute('aria-label')).toBe('Chat list');
		expect(viewport.tabIndex).toBe(-1);

		await fireEvent.click(button);

		expect(scrollTo).toHaveBeenCalledWith({ top: 0, behavior: 'auto' });
		expect(document.activeElement).toBe(viewport);
		await waitFor(() => expect(screen.queryByRole('button', { name: 'Back to top' })).toBeNull());
	});

	it('updates for pane resizes and preserves focus when a resize hides the control', async () => {
		const chats = Array.from({ length: 20 }, (_, index) =>
			createChat(`chat-${index}`, `Chat ${index}`),
		);
		const { container } = render(SidebarHost, {
			chats,
			autoLoadSavedSearches: false,
		});
		const viewport = container.querySelector<HTMLElement>('[data-slot="scroll-area-viewport"]');
		if (!viewport) throw new Error('Expected the sidebar scroll viewport');

		Object.defineProperty(viewport, 'clientHeight', { configurable: true, value: 400 });
		viewport.scrollTop = 401;
		await fireEvent.scroll(viewport);
		const button = await screen.findByRole('button', { name: 'Back to top' });
		button.focus();

		Object.defineProperty(viewport, 'clientHeight', { configurable: true, value: 1_000 });
		for (const observer of ResizeObserverHarness.instances) {
			if (observer.observed.has(viewport)) {
				ResizeObserverHarness.emitFrom(observer, viewport, 300, 1_000);
			}
		}

		await waitFor(() => expect(screen.queryByRole('button', { name: 'Back to top' })).toBeNull());
		expect(document.activeElement).toBe(viewport);
	});
});

async function openDisplay() {
	await fireEvent.click(screen.getAllByRole('button', { name: 'More actions' })[0]);
	await fireEvent.click(await screen.findByRole('menuitem', { name: 'Sidebar display' }));
	await screen.findByRole('dialog');
}
