import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { tick } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import SidebarChatListHost from './SidebarChatListHost.svelte';
import SidebarVirtualSortableChatListHost from './SidebarVirtualSortableChatListHost.svelte';
import {
	CHAT_ROW_SEPARATOR_SLOT_HEIGHT,
	PROJECT_HEADER_ROW_HEIGHT,
	type SidebarVirtualChatRow,
	type SidebarVirtualRow,
} from '../sidebar-virtual-chat-list';
import { sidebarProjectKey } from '../sidebar-row-model';
import type { SidebarChatReorderState } from '../sidebar-chat-reorder-state.svelte';
import type { WorkspaceWindowDndController } from '$lib/workspace/window-dnd.svelte.js';
import type { ChatSessionRecord } from '$lib/types/chat-session';

const rowHeight = 88;
let originalElementsFromPoint: typeof document.elementsFromPoint | undefined;

function touchAt(identifier: number, clientX: number, clientY: number) {
	return {
		identifier,
		clientX,
		clientY,
		pageX: clientX,
		pageY: clientY,
		screenX: clientX,
		screenY: clientY,
	};
}

function rect(input: { left: number; top: number; width: number; height: number }): DOMRect {
	return {
		x: input.left,
		y: input.top,
		left: input.left,
		top: input.top,
		width: input.width,
		height: input.height,
		right: input.left + input.width,
		bottom: input.top + input.height,
		toJSON() {
			return this;
		},
	} as DOMRect;
}

function makeChat(index: number, overrides: Partial<ChatSessionRecord> = {}): ChatSessionRecord {
	return {
		id: `chat-${index}`,
		projectPath: '/tmp/project',
		effectiveProjectKey: '/tmp/project',
		projectIdentityState: 'available',
		orderGroup: 'normal',
		title: `Chat ${index}`,
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
		lastMessage: `Chat ${index} preview`,
		tags: [],
		firstMessage: `Chat ${index} first`,
		...overrides,
		parentChat: overrides.parentChat ?? null,
		agentOwnershipEpoch: overrides.agentOwnershipEpoch ?? null,
	};
}

function makeRows(count: number): SidebarVirtualChatRow[] {
	const reorderScopeIds = Array.from({ length: count }, (_, scopeIndex) => `chat-${scopeIndex}`);
	return Array.from({ length: count }, (_, index) => {
		const chat = makeChat(index);
		return {
			type: 'chat' as const,
			key: `normal:${chat.id}`,
			chat,
			list: 'normal' as const,
			isPinned: false,
			isArchived: false,
			projectPath: chat.projectPath,
			groupProjectKey: sidebarProjectKey(chat.projectPath),
			groupProjectPath: chat.projectPath,
			showProjectPathInGroup: false,
			reorderScopeKey: 'normal:all',
			reorderScopeIds,
		};
	});
}

function makeScopedRow(
	index: number,
	projectPath: string,
	scopeIds: string[],
): SidebarVirtualChatRow {
	const chat = makeChat(index, { projectPath });
	return {
		type: 'chat',
		key: `normal:${chat.id}`,
		chat,
		list: 'normal',
		isPinned: false,
		isArchived: false,
		projectPath: chat.projectPath,
		groupProjectKey: sidebarProjectKey(projectPath),
		groupProjectPath: projectPath,
		showProjectPathInGroup: false,
		reorderScopeKey: `normal:project:${projectPath}`,
		reorderScopeIds: scopeIds,
	};
}

function makeProjectHeader(
	projectPath: string,
	count: number,
	chatIds: string[] = [],
	isCollapsed = false,
): SidebarVirtualRow {
	return {
		type: 'project-header',
		key: `project:${sidebarProjectKey(projectPath)}`,
		projectKey: sidebarProjectKey(projectPath),
		projectPath,
		count,
		chatIds,
		isCollapsed,
	};
}

function installTouchGeometry() {
	const viewport = screen.getByTestId('virtual-sidebar-viewport');
	const row0 = document.querySelector<HTMLElement>('[data-sidebar-virtual-row="chat-0"]');
	const row1 = document.querySelector<HTMLElement>('[data-sidebar-virtual-row="chat-1"]');
	if (!row0 || !row1) throw new Error('expected test rows to be rendered');

	vi.spyOn(viewport, 'getBoundingClientRect').mockReturnValue(
		rect({
			left: 0,
			top: 0,
			width: 320,
			height: 640,
		}),
	);
	vi.spyOn(row0, 'getBoundingClientRect').mockReturnValue(
		rect({
			left: 0,
			top: 0,
			width: 320,
			height: rowHeight,
		}),
	);
	vi.spyOn(row1, 'getBoundingClientRect').mockReturnValue(
		rect({
			left: 0,
			top: rowHeight,
			width: 320,
			height: rowHeight,
		}),
	);
	vi.spyOn(document, 'elementFromPoint').mockImplementation((_, y) =>
		y >= rowHeight ? row1 : row0,
	);

	return { row0, row1, viewport };
}

function querySummaryProjectPath(projectPath: string): HTMLElement | null {
	return document.querySelector<HTMLElement>(
		`[data-slot="sidebar-chat-summary"] [title="${projectPath}"]`,
	);
}

function expectInlineGroupHeaderDivider(header: HTMLElement): void {
	const label = header.querySelector<HTMLElement>('[data-sidebar-group-header-label]');
	const divider = header.querySelector<HTMLElement>('[data-sidebar-group-header-divider]');
	const count = header.querySelector<HTMLElement>('[data-sidebar-group-header-count]');
	const disclosureIcon = label?.nextElementSibling;

	expect(label).toBeTruthy();
	expect(disclosureIcon?.tagName.toLowerCase()).toBe('svg');
	expect(disclosureIcon?.nextElementSibling).toBe(divider);
	expect(divider?.nextElementSibling).toBe(count);
	expect(divider?.className).toContain('h-px');
	expect(divider?.className).toContain('flex-1');
	expect(header.parentElement?.className ?? '').not.toMatch(/\bborder-b\b/);
}

function isSidebarViewport(element: HTMLElement): boolean {
	return (
		element.dataset.testid === 'virtual-sidebar-viewport' ||
		element.dataset.testid === 'sidebar-list-viewport'
	);
}

beforeEach(() => {
	originalElementsFromPoint = document.elementsFromPoint;
	if (!originalElementsFromPoint) {
		Object.defineProperty(document, 'elementsFromPoint', {
			configurable: true,
			value: () => [],
		});
	}
	vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (
		this: HTMLElement,
	) {
		return isSidebarViewport(this) ? 640 : 0;
	});
	vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function (
		this: HTMLElement,
	) {
		if (!isSidebarViewport(this)) return 0;
		const list = this.querySelector<HTMLElement>('[data-sidebar-virtual-list]');
		return Math.max(640, Number.parseFloat(list?.style.height ?? '0') || 0);
	});
	vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
		this: HTMLElement,
	) {
		if (isSidebarViewport(this)) return rect({ left: 0, top: 0, width: 320, height: 640 });
		if (this.hasAttribute('data-sidebar-virtual-sizer')) {
			const viewport = this.closest<HTMLElement>('[data-testid$="sidebar-viewport"]');
			return rect({
				left: 0,
				top: -(viewport?.scrollTop ?? 0),
				width: 320,
				height: Number.parseFloat(this.style.height) || 0,
			});
		}
		return rect({ left: 0, top: 0, width: 320, height: rowHeight });
	});
});

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	if (originalElementsFromPoint) document.elementsFromPoint = originalElementsFromPoint;
	else Reflect.deleteProperty(document, 'elementsFromPoint');
});

describe('SidebarVirtualSortableChatList', () => {
	it('renders a bounded visible slice for large chat arrays', () => {
		render(SidebarVirtualSortableChatListHost, {
			rows: makeRows(500),
			rowHeight,
		});

		expect(screen.getByText('Chat 0')).toBeTruthy();
		expect(screen.queryByText('Chat 499')).toBeNull();
		expect(document.querySelectorAll('[data-sidebar-virtual-row]').length).toBeLessThan(40);
		expect(screen.getByText('Chat 0').closest('button')?.hasAttribute('draggable')).toBe(false);
	});

	it('renders mixed project header rows inside the virtual list', () => {
		render(SidebarChatListHost, {
			chats: Array.from({ length: 120 }, (_, index) =>
				makeChat(index, { projectPath: `/tmp/project-${index % 20}` }),
			),
			displayOptions: {
				grouping: 'project',
				groupNestedProjectPaths: false,
				chatItemLayout: 'default',
				sortMode: 'manual',
			},
		});

		expect(document.querySelector('[data-sidebar-virtual-list]')).toBeTruthy();
		expect(document.querySelector('[data-sidebar-project-header="/tmp/project-0"]')).toBeTruthy();
		expect(
			document.querySelectorAll('[data-sidebar-virtual-item="project-header"]').length,
		).toBeGreaterThan(0);
		expect(document.querySelectorAll('[data-sidebar-virtual-row]').length).toBeLessThan(40);
		expect(screen.queryByText('Chat 119')).toBeNull();
	});

	it('places disclosure arrows after group labels and replaces header borders with inline dividers', () => {
		const sectionHeader: SidebarVirtualRow = {
			type: 'section-header',
			key: 'section:inactive',
			section: 'inactive',
			count: 3,
			chatIds: ['chat-1', 'chat-2', 'chat-3'],
			isCollapsed: true,
		};

		render(SidebarVirtualSortableChatListHost, {
			rows: [makeProjectHeader('/tmp/project-a', 2), sectionHeader],
		});

		const projectHeader = document.querySelector<HTMLElement>(
			'[data-sidebar-project-header="/tmp/project-a"]',
		);
		const activityHeader = document.querySelector<HTMLElement>(
			'[data-sidebar-section-header="inactive"]',
		);
		if (!projectHeader || !activityHeader) throw new Error('expected both group header types');

		expectInlineGroupHeaderDivider(projectHeader);
		expectInlineGroupHeaderDivider(activityHeader);
	});

	it('renders collapsed project groups as header-only virtual rows', () => {
		const chats = [
			makeChat(0, { projectPath: '/tmp/project-a' }),
			makeChat(1, { projectPath: '/tmp/project-a' }),
			makeChat(2, { projectPath: '/tmp/project-b' }),
		];

		render(SidebarChatListHost, {
			chats,
			displayOptions: {
				grouping: 'project',
				groupNestedProjectPaths: false,
				chatItemLayout: 'default',
				sortMode: 'manual',
			},
			collapsedProjectKeys: new Set([sidebarProjectKey('/tmp/project-a')]),
		});

		const collapsedHeader = document.querySelector<HTMLElement>(
			'[data-sidebar-project-header="/tmp/project-a"]',
		);

		expect(collapsedHeader?.dataset.sidebarProjectCollapsed).toBe('true');
		expect(screen.queryByText('Chat 0')).toBeNull();
		expect(screen.queryByText('Chat 1')).toBeNull();
		expect(screen.getByText('Chat 2')).toBeTruthy();
	});

	it('omits project path metadata for exact project groups with one distinct path', () => {
		const chats = [
			makeChat(0, { projectPath: '/tmp/project-a' }),
			makeChat(1, { projectPath: '/tmp/project-b' }),
		];

		render(SidebarChatListHost, {
			chats,
			displayOptions: {
				grouping: 'project',
				groupNestedProjectPaths: false,
				chatItemLayout: 'default',
				sortMode: 'manual',
			},
		});

		expect(document.querySelector('[data-sidebar-project-header="/tmp/project-a"]')).toBeTruthy();
		expect(document.querySelector('[data-sidebar-project-header="/tmp/project-b"]')).toBeTruthy();
		expect(querySummaryProjectPath('/tmp/project-a')).toBeNull();
		expect(querySummaryProjectPath('/tmp/project-b')).toBeNull();
	});

	it('shows actual project path metadata for every row in a merged nested project group', () => {
		const chats = [
			makeChat(0, { projectPath: '/tmp/project' }),
			makeChat(1, { projectPath: '/tmp/project/packages/app' }),
		];

		render(SidebarChatListHost, {
			chats,
			displayOptions: {
				grouping: 'project',
				groupNestedProjectPaths: true,
				chatItemLayout: 'default',
				sortMode: 'manual',
			},
		});

		expect(document.querySelector('[data-sidebar-project-header="/tmp/project"]')).toBeTruthy();
		expect(
			document.querySelector('[data-sidebar-project-header="/tmp/project/packages/app"]'),
		).toBeNull();
		expect(querySummaryProjectPath('/tmp/project')).toBeTruthy();
		expect(querySummaryProjectPath('/tmp/project/packages/app')).toBeTruthy();
	});

	it('keeps sibling groups separate and omits project path metadata for each sibling group', () => {
		const chats = [
			makeChat(0, { projectPath: '/tmp/project/packages/a' }),
			makeChat(1, { projectPath: '/tmp/project/packages/b' }),
		];

		render(SidebarChatListHost, {
			chats,
			displayOptions: {
				grouping: 'project',
				groupNestedProjectPaths: true,
				chatItemLayout: 'default',
				sortMode: 'manual',
			},
		});

		expect(
			document.querySelector('[data-sidebar-project-header="/tmp/project/packages/a"]'),
		).toBeTruthy();
		expect(
			document.querySelector('[data-sidebar-project-header="/tmp/project/packages/b"]'),
		).toBeTruthy();
		expect(querySummaryProjectPath('/tmp/project/packages/a')).toBeNull();
		expect(querySummaryProjectPath('/tmp/project/packages/b')).toBeNull();
	});

	// Returns headers and chat rows in DOM order, labeled by project path (header)
	// or chat id (row), so tests can assert both group order and within-group order.
	function readVirtualRowOrder(): string[] {
		return Array.from(
			document.querySelectorAll<HTMLElement>(
				'[data-sidebar-project-header], [data-sidebar-section-header], [data-sidebar-virtual-row]',
			),
		).map(
			(element) =>
				element.getAttribute('data-sidebar-project-header') ??
				element.getAttribute('data-sidebar-section-header') ??
				element.getAttribute('data-sidebar-virtual-row') ??
				'',
		);
	}

	it('sorts chats newest-first within each project group while keeping groups alphabetical', () => {
		// Scrambled input; project-b holds the globally newest chat, but project-a
		// must still render first (alphabetical group order is independent of recency).
		const chats = [
			makeChat(0, { projectPath: '/tmp/project-b', lastActivityAt: '2025-09-01T00:00:00.000Z' }),
			makeChat(1, { projectPath: '/tmp/project-a', lastActivityAt: '2025-03-01T00:00:00.000Z' }),
			makeChat(2, { projectPath: '/tmp/project-a', lastActivityAt: '2025-01-01T00:00:00.000Z' }),
			makeChat(3, { projectPath: '/tmp/project-b', lastActivityAt: '2025-05-01T00:00:00.000Z' }),
		];

		render(SidebarChatListHost, {
			chats,
			displayOptions: {
				grouping: 'project',
				groupNestedProjectPaths: false,
				chatItemLayout: 'default',
				sortMode: 'recent',
			},
		});

		expect(readVirtualRowOrder()).toEqual([
			'/tmp/project-a',
			'chat-1',
			'chat-2',
			'/tmp/project-b',
			'chat-0',
			'chat-3',
		]);
	});

	it('sorts the flat list newest-first across projects when grouping is off', () => {
		const chats = [
			makeChat(0, { projectPath: '/tmp/project-b', lastActivityAt: '2025-03-01T00:00:00.000Z' }),
			makeChat(1, { projectPath: '/tmp/project-a', lastActivityAt: '2025-09-01T00:00:00.000Z' }),
			makeChat(2, { projectPath: '/tmp/project-b', lastActivityAt: '2025-01-01T00:00:00.000Z' }),
			makeChat(3, { projectPath: '/tmp/project-a', lastActivityAt: '2025-05-01T00:00:00.000Z' }),
		];

		render(SidebarChatListHost, {
			chats,
			displayOptions: {
				grouping: 'none',
				groupNestedProjectPaths: false,
				chatItemLayout: 'default',
				sortMode: 'recent',
			},
		});

		expect(readVirtualRowOrder()).toEqual(['chat-1', 'chat-3', 'chat-0', 'chat-2']);
	});

	it('keeps collapsed activity sections expandable across the reconciled reorder pass', async () => {
		const chats = [
			makeChat(0, {
				status: 'running',
				projectPath: '/tmp/project-a',
				createdAt: '2024-12-20T00:00:00.000Z',
				lastActivityAt: '2024-12-20T00:00:00.000Z',
			}),
			makeChat(1, {
				status: 'running',
				projectPath: '/tmp/project-b',
				createdAt: '2024-12-21T00:00:00.000Z',
				lastActivityAt: '2024-12-21T00:00:00.000Z',
			}),
			makeChat(2, { status: 'running', projectPath: '/tmp/project-a', isArchived: true }),
		];
		const displayOptions = {
			grouping: 'project-and-activity',
			inactivityDuration: '3-days',
			groupNestedProjectPaths: false,
			chatItemLayout: 'default',
			sortMode: 'manual',
		} as const;
		let collapsedProjectKeys = new Set<string>();
		const toggleCollapsed = (key: string) => {
			const next = new Set(collapsedProjectKeys);
			if (next.has(key)) next.delete(key);
			else next.add(key);
			collapsedProjectKeys = next;
		};

		const view = render(SidebarChatListHost, {
			chats,
			displayOptions,
			collapsedProjectKeys,
			onToggleProjectCollapsed: toggleCollapsed,
		});

		const sectionHeader = (section: string): HTMLElement => {
			const element = document.querySelector<HTMLElement>(
				`[data-sidebar-section-header="${section}"]`,
			);
			if (!element) throw new Error(`missing section header: ${section}`);
			return element;
		};

		expect(readVirtualRowOrder()).toEqual([
			'inactive',
			'chat-0',
			'chat-1',
			'archived',
			'chat-2',
		]);

		await fireEvent.click(sectionHeader('inactive'));
		await view.rerender({ chats, displayOptions, collapsedProjectKeys, onToggleProjectCollapsed: toggleCollapsed });
		expect(readVirtualRowOrder()).toEqual(['inactive', 'archived', 'chat-2']);

		await fireEvent.click(sectionHeader('archived'));
		await view.rerender({ chats, displayOptions, collapsedProjectKeys, onToggleProjectCollapsed: toggleCollapsed });
		expect(readVirtualRowOrder()).toEqual(['inactive', 'archived']);

		await fireEvent.click(sectionHeader('inactive'));
		await fireEvent.click(sectionHeader('archived'));
		await view.rerender({ chats, displayOptions, collapsedProjectKeys, onToggleProjectCollapsed: toggleCollapsed });
		expect(readVirtualRowOrder()).toEqual([
			'inactive',
			'chat-0',
			'chat-1',
			'archived',
			'chat-2',
		]);
	});

	it('collapses and re-expands Active, Inactive, and Archived activity groups', async () => {
		const chats = [
			makeChat(0, {
				status: 'running',
				isPinned: true,
				projectPath: '/tmp/pinned-project',
				lastActivityAt: '2024-12-01T00:00:00.000Z',
			}),
			makeChat(1, {
				status: 'running',
				projectPath: '/tmp/active-project',
				lastActivityAt: '2025-01-01T02:00:00.000Z',
			}),
			makeChat(2, {
				status: 'running',
				projectPath: '/tmp/inactive-project',
				createdAt: '2024-12-20T00:00:00.000Z',
				lastActivityAt: '2024-12-20T00:00:00.000Z',
			}),
			makeChat(3, {
				status: 'running',
				isArchived: true,
				projectPath: '/tmp/archived-project',
			}),
		];
		const displayOptions = {
			grouping: 'activity',
			inactivityDuration: '3-days',
		} as const;
		let collapsedProjectKeys = new Set<string>();
		const toggleCollapsed = (key: string) => {
			const next = new Set(collapsedProjectKeys);
			if (next.has(key)) next.delete(key);
			else next.add(key);
			collapsedProjectKeys = next;
		};
		const view = render(SidebarChatListHost, {
			chats,
			displayOptions,
			collapsedProjectKeys,
			onToggleProjectCollapsed: toggleCollapsed,
		});
		const sectionHeader = (section: string): HTMLElement => {
			const element = document.querySelector<HTMLElement>(
				`[data-sidebar-section-header="${section}"]`,
			);
			if (!element) throw new Error(`missing section header: ${section}`);
			return element;
		};
		const rerender = async (): Promise<void> => {
			await view.rerender({
				chats,
				displayOptions,
				collapsedProjectKeys,
				onToggleProjectCollapsed: toggleCollapsed,
			});
		};

		expect(readVirtualRowOrder()).toEqual([
			'active',
			'chat-0',
			'chat-1',
			'inactive',
			'chat-2',
			'archived',
			'chat-3',
		]);
		for (const projectPath of [
			'/tmp/pinned-project',
			'/tmp/active-project',
			'/tmp/inactive-project',
			'/tmp/archived-project',
		]) {
			expect(querySummaryProjectPath(projectPath)).toBeTruthy();
		}

		for (const section of ['active', 'inactive', 'archived']) {
			await fireEvent.click(sectionHeader(section));
			await rerender();
		}
		expect(readVirtualRowOrder()).toEqual(['active', 'inactive', 'archived']);

		for (const section of ['active', 'inactive', 'archived']) {
			await fireEvent.click(sectionHeader(section));
			await rerender();
		}
		expect(readVirtualRowOrder()).toEqual([
			'active',
			'chat-0',
			'chat-1',
			'inactive',
			'chat-2',
			'archived',
			'chat-3',
		]);
	});

	it.each(['project-and-activity', 'activity'] as const)(
		'preserves the metadata-free single-line layout for %s grouping',
		(grouping) => {
			const projectPath = '/tmp/inactive-project';
			render(SidebarChatListHost, {
				chats: [
					makeChat(0, {
						status: 'running',
						projectPath,
						lastActivityAt: '2024-12-20T00:00:00.000Z',
					}),
				],
				displayOptions: {
					grouping,
					inactivityDuration: '3-days',
					chatItemLayout: 'single-line',
				},
			});

			expect(querySummaryProjectPath(projectPath)).toBeNull();
		},
	);

	it('renders a timestamp-less local draft first under recent sort', () => {
		const chats = [
			makeChat(0, {
				status: 'running',
				lastActivityAt: '2025-09-01T00:00:00.000Z',
			}),
			makeChat(1, { createdAt: null, lastActivityAt: null }),
			makeChat(2, {
				status: 'running',
				lastActivityAt: '2025-01-01T00:00:00.000Z',
			}),
		];

		render(SidebarChatListHost, {
			chats,
			displayOptions: {
				grouping: 'none',
				groupNestedProjectPaths: false,
				chatItemLayout: 'default',
				sortMode: 'recent',
			},
		});

		expect(readVirtualRowOrder()).toEqual(['chat-1', 'chat-0', 'chat-2']);
	});

	it('preserves the given order within groups under manual sort', () => {
		// Manual mode must not reorder by recency: input order wins within each group.
		const chats = [
			makeChat(0, { projectPath: '/tmp/project-a', lastActivityAt: '2025-01-01T00:00:00.000Z' }),
			makeChat(1, { projectPath: '/tmp/project-a', lastActivityAt: '2025-09-01T00:00:00.000Z' }),
			makeChat(2, { projectPath: '/tmp/project-b', lastActivityAt: '2025-05-01T00:00:00.000Z' }),
		];

		render(SidebarChatListHost, {
			chats,
			displayOptions: {
				grouping: 'project',
				groupNestedProjectPaths: false,
				chatItemLayout: 'default',
				sortMode: 'manual',
			},
		});

		expect(readVirtualRowOrder()).toEqual([
			'/tmp/project-a',
			'chat-0',
			'chat-1',
			'/tmp/project-b',
			'chat-2',
		]);
	});

	it('collapses a grouped project when the list is shorter than the viewport', async () => {
		const chats = [
			makeChat(0, { projectPath: '/tmp/project-a' }),
			makeChat(1, { projectPath: '/tmp/project-a' }),
			makeChat(2, { projectPath: '/tmp/project-b' }),
		];

		render(SidebarChatListHost, {
			chats,
			displayOptions: {
				grouping: 'project',
				groupNestedProjectPaths: false,
				chatItemLayout: 'default',
				sortMode: 'manual',
			},
		});

		const header = document.querySelector<HTMLElement>(
			'[data-sidebar-project-header="/tmp/project-a"]',
		);
		if (!header) throw new Error('expected project header');

		expect(screen.getByText('Chat 0')).toBeTruthy();
		expect(screen.getByText('Chat 1')).toBeTruthy();
		await fireEvent.click(header);
		await tick();

		expect(header.dataset.sidebarProjectCollapsed).toBe('true');
		expect(screen.queryByText('Chat 0')).toBeNull();
		expect(screen.queryByText('Chat 1')).toBeNull();
		expect(screen.getByText('Chat 2')).toBeTruthy();
	});

	it('toggles a project header collapse state', async () => {
		const onToggleProjectCollapsed = vi.fn();

		render(SidebarVirtualSortableChatListHost, {
			rows: [makeProjectHeader('/tmp/project-a', 2, ['chat-0', 'chat-1'], true)],
			onToggleProjectCollapsed,
		});

		const header = document.querySelector<HTMLElement>(
			'[data-sidebar-project-header="/tmp/project-a"]',
		);
		if (!header) throw new Error('expected project header');

		expect(header.getAttribute('aria-expanded')).toBe('false');
		await fireEvent.click(header);

		expect(onToggleProjectCollapsed).toHaveBeenCalledWith(sidebarProjectKey('/tmp/project-a'));
	});

	it('uses compact chat row estimates in compact mode', () => {
		render(SidebarVirtualSortableChatListHost, {
			rows: makeRows(20),
			displayOptions: {
				grouping: 'none',
				groupNestedProjectPaths: false,
				chatItemLayout: 'compact',
				sortMode: 'manual',
			},
		});

		const firstVirtualItem = document.querySelector<HTMLElement>(
			'[data-sidebar-virtual-item="chat"]',
		);

		expect(firstVirtualItem?.style.height).toBe('70px');
	});

	it('uses single-line chat row estimates in single-line mode', () => {
		render(SidebarVirtualSortableChatListHost, {
			rows: makeRows(20),
			displayOptions: {
				grouping: 'none',
				groupNestedProjectPaths: false,
				chatItemLayout: 'single-line',
				sortMode: 'manual',
			},
		});

		const firstVirtualItem = document.querySelector<HTMLElement>(
			'[data-sidebar-virtual-item="chat"]',
		);

		expect(firstVirtualItem?.style.height).toBe('40px');
	});

	it('drops separators and the separator slot in single-line mode', () => {
		render(SidebarVirtualSortableChatListHost, {
			rows: makeRows(20),
			displayOptions: {
				grouping: 'none',
				groupNestedProjectPaths: false,
				chatItemLayout: 'single-line',
				sortMode: 'manual',
			},
		});

		expect(document.querySelectorAll('[data-sidebar-virtual-list-separator]')).toHaveLength(0);

		const row = document.querySelector<HTMLElement>('[data-sidebar-virtual-row="chat-1"]');
		const rowContent = row?.querySelector<HTMLElement>('[data-sidebar-virtual-row-content]');
		expect(rowContent?.style.height).toBe('100%');
	});

	it('re-estimates chat row sizes when the layout switches after mount', async () => {
		const view = render(SidebarVirtualSortableChatListHost, {
			rows: makeRows(20),
			displayOptions: {
				grouping: 'none',
				groupNestedProjectPaths: false,
				chatItemLayout: 'default',
				sortMode: 'manual',
			},
		});

		const firstVirtualItem = () =>
			document.querySelector<HTMLElement>('[data-sidebar-virtual-item="chat"]');

		expect(firstVirtualItem()?.style.height).toBe('88px');

		await view.rerender({
			rows: makeRows(20),
			displayOptions: {
				grouping: 'none',
				groupNestedProjectPaths: false,
				chatItemLayout: 'single-line',
				sortMode: 'manual',
			},
		});

		await tick();

		expect(firstVirtualItem()?.style.height).toBe('40px');
	});

	it('keeps the anchored chat row visible when the layout switches while scrolled', async () => {
		const view = render(SidebarVirtualSortableChatListHost, {
			rows: makeRows(60),
			displayOptions: {
				grouping: 'none',
				groupNestedProjectPaths: false,
				chatItemLayout: 'default',
				sortMode: 'manual',
			},
		});

		const viewport = document.querySelector<HTMLElement>(
			'[data-testid="virtual-sidebar-viewport"]',
		);
		if (!viewport) throw new Error('expected viewport');

		viewport.scrollTop = 2000;
		viewport.dispatchEvent(new Event('scroll'));
		await tick();

		await view.rerender({
			rows: makeRows(60),
			displayOptions: {
				grouping: 'none',
				groupNestedProjectPaths: false,
				chatItemLayout: 'single-line',
				sortMode: 'manual',
			},
		});

		await waitFor(() => {
			// chat-22 spans [1936, 2024) at 88px; scrollTop 2000 is 64/88 into the
			// row. At 40px it spans [880, 920) and the normalized offset is
			// round(64/88 * 40) = 29, so the restore keeps chat-22 itself visible.
			expect(viewport.scrollTop).toBe(909);
		});

		// happy-dom does not emit a scroll event for programmatic writes, which
		// the virtualizer needs to recompute its visible range.
		viewport.dispatchEvent(new Event('scroll'));
		await tick();

		const anchoredRow = document.querySelector<HTMLElement>('[data-sidebar-virtual-row="chat-22"]');
		if (!anchoredRow) throw new Error('expected anchored row to stay mounted');
		// happy-dom bounding rects ignore transforms, so verify the rendered
		// position arithmetically: the row spans [880, 920) inside the
		// viewport window [909, 909 + 640).
		expect(anchoredRow.parentElement?.style.transform).toContain('translateY(880px)');
	});

	it('leaves the scroll offset untouched for explicit row heights', async () => {
		const view = render(SidebarVirtualSortableChatListHost, {
			rows: makeRows(60),
			rowHeight: 88,
			displayOptions: {
				grouping: 'none',
				groupNestedProjectPaths: false,
				chatItemLayout: 'default',
				sortMode: 'manual',
			},
		});

		const viewport = document.querySelector<HTMLElement>(
			'[data-testid="virtual-sidebar-viewport"]',
		);
		if (!viewport) throw new Error('expected viewport');

		viewport.scrollTop = 2000;
		viewport.dispatchEvent(new Event('scroll'));
		await tick();

		await view.rerender({
			rows: makeRows(60),
			rowHeight: 88,
			displayOptions: {
				grouping: 'none',
				groupNestedProjectPaths: false,
				chatItemLayout: 'single-line',
				sortMode: 'manual',
			},
		});

		await waitFor(() => {
			// Uniform row geometry is unaffected by the layout switch.
			expect(viewport.scrollTop).toBe(2000);
		});
	});

	it('anchors through project headers with fractional scroll offsets', async () => {
		const groupedRows = (): SidebarVirtualRow[] => [
			makeProjectHeader('/tmp/project-a', 1, ['chat-0']),
			...makeRows(16).slice(0, 1),
			makeProjectHeader(
				'/tmp/project-b',
				15,
				makeRows(16)
					.slice(1)
					.map((row) => row.chat.id),
			),
			...makeRows(16).slice(1),
		];
		const view = render(SidebarVirtualSortableChatListHost, {
			rows: groupedRows(),
			displayOptions: {
				grouping: 'project',
				groupNestedProjectPaths: false,
				chatItemLayout: 'default',
				sortMode: 'manual',
			},
		});

		const viewport = document.querySelector<HTMLElement>(
			'[data-testid="virtual-sidebar-viewport"]',
		);
		if (!viewport) throw new Error('expected viewport');

		// Default geometry: header 32px, chats 88px; chat-1 spans [152, 240)
		// behind the second header, and scrollTop 160.5 is 8.5px into the row.
		viewport.scrollTop = 160.5;
		viewport.dispatchEvent(new Event('scroll'));
		await tick();

		await view.rerender({
			rows: groupedRows(),
			displayOptions: {
				grouping: 'project',
				groupNestedProjectPaths: false,
				chatItemLayout: 'single-line',
				sortMode: 'manual',
			},
		});

		await waitFor(() => {
			// The normalized 108px target exceeds the shrunken list's 80px maximum.
			expect(viewport.scrollTop).toBe(80);
		});

		viewport.dispatchEvent(new Event('scroll'));
		await tick();

		const anchoredRow = document.querySelector<HTMLElement>('[data-sidebar-virtual-row="chat-1"]');
		if (!anchoredRow) throw new Error('expected anchored row to stay mounted');
		expect(anchoredRow.parentElement?.style.transform).toContain('translateY(104px)');
	});

	it('keeps the bottom-most chat row visible when the list shrinks', async () => {
		const view = render(SidebarVirtualSortableChatListHost, {
			rows: makeRows(60),
			displayOptions: {
				grouping: 'none',
				groupNestedProjectPaths: false,
				chatItemLayout: 'default',
				sortMode: 'manual',
			},
		});

		const viewport = document.querySelector<HTMLElement>(
			'[data-testid="virtual-sidebar-viewport"]',
		);
		if (!viewport) throw new Error('expected viewport');

		// Bottom of the default list: chat-52 spans [4576, 4664) and the 88px
		// content tops out at scrollTop 4640, 64px into the row.
		viewport.scrollTop = 4640;
		viewport.dispatchEvent(new Event('scroll'));
		await tick();

		await view.rerender({
			rows: makeRows(60),
			displayOptions: {
				grouping: 'none',
				groupNestedProjectPaths: false,
				chatItemLayout: 'single-line',
				sortMode: 'manual',
			},
		});

		// The normalized 2109px target exceeds the shrunken list's 1776px maximum,
		// including the 16px trailing padding, so Virt records the attained clamp.
		await waitFor(() => {
			expect(viewport.scrollTop).toBe(1776);
		});

		viewport.dispatchEvent(new Event('scroll'));
		await tick();

		const anchoredRow = document.querySelector<HTMLElement>('[data-sidebar-virtual-row="chat-52"]');
		if (!anchoredRow) throw new Error('expected anchored row to stay mounted');
		expect(anchoredRow.parentElement?.style.transform).toContain('translateY(2080px)');
	});

	it('paints chat separators from the virtual list layer', () => {
		render(SidebarVirtualSortableChatListHost, {
			rows: makeRows(20),
			selectedChatId: 'chat-1',
			rowHeight,
		});

		const separator = document.querySelector<HTMLElement>('[data-sidebar-virtual-list-separator]');
		const selectedBackground = document.querySelector<HTMLElement>(
			'[data-sidebar-virtual-list-selected-background]',
		);
		const row = document.querySelector<HTMLElement>('[data-sidebar-virtual-row="chat-1"]');
		const rowContent = row?.querySelector<HTMLElement>('[data-sidebar-virtual-row-content]');

		expect(separator).toBeTruthy();
		expect(separator?.className).toContain('bg-border');
		expect(separator?.className).toContain('z-10');
		expect(separator?.style.top).toBe('87px');
		expect(separator?.style.height).toBe('1px');
		expect(selectedBackground?.className).toContain('bg-sidebar-chat-item-selected-bg');
		expect(selectedBackground?.style.top).toBe(`${rowHeight - CHAT_ROW_SEPARATOR_SLOT_HEIGHT}px`);
		expect(selectedBackground?.style.height).toBe(
			`${rowHeight + CHAT_ROW_SEPARATOR_SLOT_HEIGHT}px`,
		);
		expect(row?.className).toContain('bg-sidebar-chat-item-selected-bg');
		expect(rowContent?.className).toContain('bg-sidebar-chat-item-selected-bg');
		expect(rowContent?.className).not.toContain('bg-sidebar-chat-item-bg');
		expect(row?.className).not.toContain('border-b');
		expect(row?.className).not.toContain('border-border');
		expect(rowContent?.style.height).toBe(`calc(100% - ${CHAT_ROW_SEPARATOR_SLOT_HEIGHT}px)`);
	});

	it('updates visible rows when the shared viewport scrolls', async () => {
		render(SidebarVirtualSortableChatListHost, {
			rows: makeRows(500),
			rowHeight,
		});

		const viewport = screen.getByTestId('virtual-sidebar-viewport');
		viewport.scrollTop = rowHeight * 120;
		await fireEvent.scroll(viewport);
		await tick();

		expect(screen.getByText('Chat 120')).toBeTruthy();
		expect(screen.queryByText('Chat 0')).toBeNull();
	});

	it('scrolls an offscreen selected chat into view on recenter requests', async () => {
		const callbacks: Array<() => void> = [];

		render(SidebarVirtualSortableChatListHost, {
			rows: makeRows(500),
			selectedChatId: 'chat-400',
			rowHeight,
			onRegisterRecenter: (callback: () => void) => callbacks.push(callback),
		});
		await tick();

		for (const callback of callbacks) callback();
		await tick();

		const viewport = screen.getByTestId('virtual-sidebar-viewport');
		expect(viewport.scrollTop).toBeGreaterThan(rowHeight * 350);
	});

	it('applies a recenter request after the selected chat row hydrates', async () => {
		const callbacks: Array<() => void> = [];
		const view = render(SidebarVirtualSortableChatListHost, {
			rows: [],
			selectedChatId: 'chat-400',
			rowHeight,
			onRegisterRecenter: (callback: () => void) => callbacks.push(callback),
		});
		await tick();

		for (const callback of callbacks) callback();
		await tick();
		expect(screen.getByTestId('virtual-sidebar-viewport').scrollTop).toBe(0);

		await view.rerender({
			rows: makeRows(500),
			selectedChatId: 'chat-400',
			rowHeight,
			onRegisterRecenter: (callback: () => void) => callbacks.push(callback),
		});
		await tick();

		expect(screen.getByTestId('virtual-sidebar-viewport').scrollTop).toBeGreaterThan(
			rowHeight * 350,
		);
	});

	it('retains a recenter request until the virtual viewport binds', async () => {
		const callbacks: Array<() => void> = [];
		const props = {
			rows: makeRows(500),
			selectedChatId: 'chat-400',
			rowHeight,
			viewportAttached: false,
			onRegisterRecenter: (callback: () => void) => callbacks.push(callback),
		};
		const view = render(SidebarVirtualSortableChatListHost, props);
		await tick();

		for (const callback of callbacks) callback();
		await tick();
		expect(screen.getByTestId('virtual-sidebar-viewport').scrollTop).toBe(0);

		await view.rerender({ ...props, viewportAttached: true });
		await waitFor(() =>
			expect(screen.getByTestId('virtual-sidebar-viewport').scrollTop).toBeGreaterThan(
				rowHeight * 350,
			),
		);
	});

	it('scrolls to a collapsed project header when the selected chat row is hidden', async () => {
		const callbacks: Array<() => void> = [];
		const rows: SidebarVirtualRow[] = [
			...makeRows(100),
			makeProjectHeader('/tmp/project-hidden', 1, ['hidden-chat'], true),
		];

		render(SidebarVirtualSortableChatListHost, {
			rows,
			selectedChatId: 'hidden-chat',
			rowHeight,
			onRegisterRecenter: (callback: () => void) => callbacks.push(callback),
		});
		await tick();

		for (const callback of callbacks) callback();
		await tick();

		const viewport = screen.getByTestId('virtual-sidebar-viewport');
		expect(viewport.scrollTop).toBeGreaterThan(rowHeight * 80);
	});

	it('does not scroll when the selected chat is already visible on recenter requests', async () => {
		const callbacks: Array<() => void> = [];

		render(SidebarVirtualSortableChatListHost, {
			rows: makeRows(500),
			selectedChatId: 'chat-2',
			rowHeight,
			onRegisterRecenter: (callback: () => void) => callbacks.push(callback),
		});
		await tick();

		const viewport = screen.getByTestId('virtual-sidebar-viewport');
		viewport.scrollTop = 0;
		for (const callback of callbacks) callback();
		await tick();

		expect(viewport.scrollTop).toBe(0);
	});

	it('persists adjacent reorder after a touch long press drag', async () => {
		vi.useFakeTimers();
		const persist = vi.fn();

		render(SidebarVirtualSortableChatListHost, {
			rows: makeRows(20),
			isMobile: true,
			rowHeight,
			onPersistReorder: persist,
		});
		await tick();
		const { row0 } = installTouchGeometry();

		await fireEvent.touchStart(row0, {
			touches: [touchAt(1, 20, 44)],
			changedTouches: [touchAt(1, 20, 44)],
		});
		vi.advanceTimersByTime(370);
		await tick();
		await fireEvent.touchMove(window, {
			touches: [touchAt(1, 20, 150)],
			changedTouches: [touchAt(1, 20, 150)],
		});
		await tick();
		await fireEvent.touchEnd(window, {
			touches: [],
			changedTouches: [touchAt(1, 20, 150)],
		});
		await tick();

		expect(persist).toHaveBeenCalledWith({
			kind: 'relative',
			list: 'normal',
			chatId: 'chat-0',
			placement: { kind: 'relative', referenceChatId: 'chat-1', position: 'after' },
			visibleOrder: [
				'chat-1',
				'chat-0',
				...Array.from({ length: 18 }, (_, index) => `chat-${index + 2}`),
			],
			sequence: 1,
		});
	});

	it('preserves the dragged row element while optimistic order changes', async () => {
		vi.useFakeTimers();
		const chats = Array.from({ length: 20 }, (_, index) => makeChat(index));

		render(SidebarChatListHost, {
			chats,
			isMobile: true,
		});
		await tick();

		const viewport = screen.getByTestId('sidebar-list-viewport');
		const row0 = document.querySelector<HTMLElement>('[data-sidebar-virtual-row="chat-0"]');
		const row1 = document.querySelector<HTMLElement>('[data-sidebar-virtual-row="chat-1"]');
		if (!row0 || !row1) throw new Error('expected source and target rows to be rendered');

		vi.spyOn(viewport, 'getBoundingClientRect').mockReturnValue(
			rect({ left: 0, top: 0, width: 320, height: 640 }),
		);
		vi.spyOn(row0, 'getBoundingClientRect').mockReturnValue(
			rect({ left: 0, top: 0, width: 320, height: rowHeight }),
		);
		vi.spyOn(row1, 'getBoundingClientRect').mockReturnValue(
			rect({ left: 0, top: rowHeight, width: 320, height: rowHeight }),
		);
		vi.spyOn(document, 'elementFromPoint').mockReturnValue(row1);

		await fireEvent.touchStart(row0, {
			touches: [touchAt(1, 20, 44)],
			changedTouches: [touchAt(1, 20, 44)],
		});
		vi.advanceTimersByTime(370);
		await tick();
		await fireEvent.touchMove(window, {
			touches: [touchAt(1, 20, 150)],
			changedTouches: [touchAt(1, 20, 150)],
		});
		await tick();

		expect(
			[...document.querySelectorAll<HTMLElement>('[data-sidebar-virtual-row]')]
				.slice(0, 2)
				.map((row) => row.dataset.sidebarVirtualRow),
		).toEqual(['chat-1', 'chat-0']);
		expect(document.querySelector('[data-sidebar-virtual-row="chat-0"]')).toBe(row0);
		expect(row0.isConnected).toBe(true);

		await fireEvent.touchCancel(window, {
			touches: [],
			changedTouches: [touchAt(1, 20, 150)],
		});
	});

	it('drags a chat toward workspace windows without reordering under recent sort', async () => {
		vi.useFakeTimers();
		const persist = vi.fn();
		const workspaceDragEnd = vi.fn();
		const registered = {
			reorder: null as SidebarChatReorderState | null,
			windowDnd: null as WorkspaceWindowDndController | null,
		};

		render(SidebarVirtualSortableChatListHost, {
			rows: makeRows(20),
			rowHeight,
			displayOptions: {
				grouping: 'none',
				groupNestedProjectPaths: false,
				chatItemLayout: 'default',
				sortMode: 'recent',
			},
			onRegisterReorder: (value) => (registered.reorder = value),
			onRegisterWindowDnd: (value) => (registered.windowDnd = value),
			onPersistReorder: persist,
			onWorkspaceDragEnd: workspaceDragEnd,
		});
		await tick();

		const row0 = document.querySelector<HTMLElement>('[data-sidebar-virtual-row="chat-0"]');
		const row1 = document.querySelector<HTMLElement>('[data-sidebar-virtual-row="chat-1"]');
		if (!row0 || !row1) throw new Error('expected source and target rows to be rendered');
		expect(row0.dataset.sidebarDragDisabled).toBeUndefined();
		const dataTransfer = new DataTransfer();

		await fireEvent.dragStart(row0, { clientX: 20, clientY: 44, dataTransfer });
		vi.advanceTimersByTime(17);
		await tick();

		expect(row0.className).toContain('opacity-45');
		expect(registered.reorder?.activeList).toBeNull();
		expect(registered.windowDnd?.payload).toEqual({
			kind: 'chat',
			chatId: 'chat-0',
			source: 'chat-list',
		});

		// Rows are not reorder targets under the derived recent sort, so a drop
		// inside the sidebar persists nothing and only ends the workspace drag.
		await fireEvent.drop(row1, { clientX: 20, clientY: rowHeight + 44, dataTransfer });
		vi.advanceTimersByTime(17);
		await tick();

		expect(persist).not.toHaveBeenCalled();
		expect(workspaceDragEnd).toHaveBeenCalledWith('chat-0');
		expect(registered.windowDnd?.payload).toBeNull();
	});

	it('keeps a recent-sort workspace drag alive when virtualization unmounts its source', async () => {
		vi.useFakeTimers();
		const persist = vi.fn();
		const workspaceDragEnd = vi.fn();
		const registered = {
			reorder: null as SidebarChatReorderState | null,
			windowDnd: null as WorkspaceWindowDndController | null,
		};

		render(SidebarVirtualSortableChatListHost, {
			rows: makeRows(500),
			rowHeight,
			displayOptions: {
				grouping: 'none',
				groupNestedProjectPaths: false,
				chatItemLayout: 'default',
				sortMode: 'recent',
			},
			onRegisterReorder: (value) => (registered.reorder = value),
			onRegisterWindowDnd: (value) => (registered.windowDnd = value),
			onPersistReorder: persist,
			onWorkspaceDragEnd: workspaceDragEnd,
		});
		await tick();

		const viewport = screen.getByTestId('virtual-sidebar-viewport');
		const row0 = document.querySelector<HTMLElement>('[data-sidebar-virtual-row="chat-0"]');
		if (!row0) throw new Error('expected source row to be rendered');
		const dataTransfer = new DataTransfer();

		await fireEvent.dragStart(row0, { clientX: 20, clientY: 44, dataTransfer });
		vi.advanceTimersByTime(17);
		await tick();
		expect(registered.windowDnd?.payload?.kind).toBe('chat');
		expect(
			registered.windowDnd?.payload?.kind === 'chat' && registered.windowDnd.payload.chatId,
		).toBe('chat-0');

		// The recent sort is derived from live activity, so a background update
		// can push the dragged row out of the virtual window mid-drag. The workspace
		// drag must survive so a drop on a workspace window still lands.
		viewport.scrollTop = rowHeight * 120;
		await fireEvent.scroll(viewport);
		await tick();

		expect(row0.isConnected).toBe(false);
		expect(workspaceDragEnd).not.toHaveBeenCalled();
		expect(registered.windowDnd?.payload?.kind).toBe('chat');

		await fireEvent.drop(window, { dataTransfer });
		vi.advanceTimersByTime(17);
		await tick();

		expect(workspaceDragEnd).toHaveBeenCalledWith('chat-0');
		expect(persist).not.toHaveBeenCalled();
	});

	it('cancels a native drag when virtualization unmounts its source', async () => {
		vi.useFakeTimers();
		const persist = vi.fn();
		const workspaceDragEnd = vi.fn();
		const registered = { reorder: null as SidebarChatReorderState | null };

		render(SidebarVirtualSortableChatListHost, {
			rows: makeRows(500),
			rowHeight,
			onRegisterReorder: (value) => (registered.reorder = value),
			onPersistReorder: persist,
			onWorkspaceDragEnd: workspaceDragEnd,
		});
		await tick();

		const viewport = screen.getByTestId('virtual-sidebar-viewport');
		const row0 = document.querySelector<HTMLElement>('[data-sidebar-virtual-row="chat-0"]');
		if (!row0) throw new Error('expected source row to be rendered');
		const dataTransfer = new DataTransfer();

		await fireEvent.dragStart(row0, { clientX: 20, clientY: 44, dataTransfer });
		vi.advanceTimersByTime(17);
		await tick();
		expect(row0.className).toContain('opacity-45');
		expect(registered.reorder?.activeList).toBe('normal');

		viewport.scrollTop = rowHeight * 120;
		await fireEvent.scroll(viewport);
		await tick();

		expect(row0.isConnected).toBe(false);
		expect(registered.reorder?.activeList).toBeNull();
		expect(workspaceDragEnd).toHaveBeenCalledWith('chat-0');
		expect(persist).not.toHaveBeenCalled();

		await fireEvent.dragEnd(window, { dataTransfer });
	});

	it('ignores a touch start while another chat owns a native drag', async () => {
		vi.useFakeTimers();
		const workspaceDragEnd = vi.fn();
		const registered = { reorder: null as SidebarChatReorderState | null };

		render(SidebarVirtualSortableChatListHost, {
			rows: makeRows(500),
			rowHeight,
			onRegisterReorder: (value) => (registered.reorder = value),
			onWorkspaceDragEnd: workspaceDragEnd,
		});
		await tick();

		const viewport = screen.getByTestId('virtual-sidebar-viewport');
		const row0 = document.querySelector<HTMLElement>('[data-sidebar-virtual-row="chat-0"]');
		const row5 = document.querySelector<HTMLElement>('[data-sidebar-virtual-row="chat-5"]');
		if (!row0 || !row5) throw new Error('expected native and touch source rows to be rendered');
		const dataTransfer = new DataTransfer();

		await fireEvent.dragStart(row5, { clientX: 20, clientY: rowHeight * 5 + 44, dataTransfer });
		vi.advanceTimersByTime(17);
		await tick();
		await fireEvent.touchStart(row0, {
			touches: [touchAt(1, 20, 44)],
			changedTouches: [touchAt(1, 20, 44)],
		});
		expect(document.body.style.getPropertyValue('user-select')).toBe('');

		viewport.scrollTop = rowHeight * 10;
		await fireEvent.scroll(viewport);
		await tick();

		expect(row0.isConnected).toBe(false);
		expect(row5.isConnected).toBe(true);
		expect(row5.className).toContain('opacity-45');
		expect(registered.reorder?.activeList).toBe('normal');
		expect(workspaceDragEnd).not.toHaveBeenCalled();

		await fireEvent.dragEnd(row5, { dataTransfer });
	});

	it('cancels a pending touch gesture before starting a native drag', async () => {
		vi.useFakeTimers();
		const registered = { reorder: null as SidebarChatReorderState | null };

		render(SidebarVirtualSortableChatListHost, {
			rows: makeRows(20),
			rowHeight,
			onRegisterReorder: (value) => (registered.reorder = value),
		});
		await tick();

		const row0 = document.querySelector<HTMLElement>('[data-sidebar-virtual-row="chat-0"]');
		const row5 = document.querySelector<HTMLElement>('[data-sidebar-virtual-row="chat-5"]');
		if (!row0 || !row5) throw new Error('expected native and touch source rows to be rendered');

		await fireEvent.touchStart(row0, {
			touches: [touchAt(1, 20, 44)],
			changedTouches: [touchAt(1, 20, 44)],
		});
		expect(document.body.style.getPropertyValue('user-select')).toBe('none');

		const dataTransfer = new DataTransfer();
		await fireEvent.dragStart(row5, { clientX: 20, clientY: rowHeight * 5 + 44, dataTransfer });
		vi.advanceTimersByTime(370);
		await tick();

		expect(document.body.style.getPropertyValue('user-select')).toBe('');
		expect(row5.className).toContain('opacity-45');
		expect(registered.reorder?.activeChatId).toBe('chat-5');

		await fireEvent.dragEnd(row5, { dataTransfer });
	});

	it('cancels an active touch drag when virtualization unmounts its source', async () => {
		vi.useFakeTimers();
		const persist = vi.fn();

		render(SidebarVirtualSortableChatListHost, {
			rows: makeRows(500),
			isMobile: true,
			rowHeight,
			onPersistReorder: persist,
		});
		await tick();

		const viewport = screen.getByTestId('virtual-sidebar-viewport');
		const row0 = document.querySelector<HTMLElement>('[data-sidebar-virtual-row="chat-0"]');
		if (!row0) throw new Error('expected source row to be rendered');

		await fireEvent.touchStart(row0, {
			touches: [touchAt(1, 20, 44)],
			changedTouches: [touchAt(1, 20, 44)],
		});
		vi.advanceTimersByTime(370);
		await tick();

		expect(row0.className).toContain('opacity-45');
		expect(document.body.style.getPropertyValue('user-select')).toBe('none');

		viewport.scrollTop = rowHeight * 120;
		await fireEvent.scroll(viewport);
		await tick();

		expect(row0.isConnected).toBe(false);
		expect(document.querySelector('.opacity-45')).toBeNull();
		expect(document.body.style.getPropertyValue('user-select')).toBe('');
		expect(document.documentElement.style.getPropertyValue('user-select')).toBe('');
		expect(persist).not.toHaveBeenCalled();
	});

	it('cancels a pending touch drag when virtualization unmounts its source', async () => {
		vi.useFakeTimers();
		const persist = vi.fn();

		render(SidebarVirtualSortableChatListHost, {
			rows: makeRows(500),
			isMobile: true,
			rowHeight,
			onPersistReorder: persist,
		});
		await tick();

		const viewport = screen.getByTestId('virtual-sidebar-viewport');
		const row0 = document.querySelector<HTMLElement>('[data-sidebar-virtual-row="chat-0"]');
		if (!row0) throw new Error('expected source row to be rendered');

		await fireEvent.touchStart(row0, {
			touches: [touchAt(1, 20, 44)],
			changedTouches: [touchAt(1, 20, 44)],
		});
		expect(document.body.style.getPropertyValue('user-select')).toBe('none');

		viewport.scrollTop = rowHeight * 120;
		await fireEvent.scroll(viewport);
		await tick();

		expect(row0.isConnected).toBe(false);
		expect(document.body.style.getPropertyValue('user-select')).toBe('');
		vi.advanceTimersByTime(370);
		await tick();
		expect(document.querySelector('.opacity-45')).toBeNull();
		expect(persist).not.toHaveBeenCalled();
	});

	it('keeps an active touch drag when virtualization unmounts another row', async () => {
		vi.useFakeTimers();

		render(SidebarVirtualSortableChatListHost, {
			rows: makeRows(500),
			isMobile: true,
			rowHeight,
		});
		await tick();

		const viewport = screen.getByTestId('virtual-sidebar-viewport');
		const row0 = document.querySelector<HTMLElement>('[data-sidebar-virtual-row="chat-0"]');
		const row5 = document.querySelector<HTMLElement>('[data-sidebar-virtual-row="chat-5"]');
		if (!row0 || !row5) throw new Error('expected source and unrelated rows to be rendered');

		await fireEvent.touchStart(row5, {
			touches: [touchAt(1, 20, rowHeight * 5 + 44)],
			changedTouches: [touchAt(1, 20, rowHeight * 5 + 44)],
		});
		vi.advanceTimersByTime(370);
		await tick();

		viewport.scrollTop = rowHeight * 10;
		await fireEvent.scroll(viewport);
		await tick();

		expect(row0.isConnected).toBe(false);
		expect(row5.isConnected).toBe(true);
		expect(row5.className).toContain('opacity-45');
		expect(document.body.style.getPropertyValue('user-select')).toBe('none');

		await fireEvent.touchCancel(window, {
			touches: [],
			changedTouches: [touchAt(1, 20, rowHeight * 5 + 44)],
		});
		await tick();

		expect(document.body.style.getPropertyValue('user-select')).toBe('');
	});

	it('persists when the optimistic preview moves the dragged row under the touch point', async () => {
		vi.useFakeTimers();
		const onQuickMove = vi.fn();
		const chats = Array.from({ length: 20 }, (_, index) => makeChat(index));

		render(SidebarChatListHost, {
			chats,
			isMobile: true,
			onQuickMove,
		});
		await tick();

		const viewport = screen.getByTestId('sidebar-list-viewport');
		const row0 = document.querySelector<HTMLElement>('[data-sidebar-virtual-row="chat-0"]');
		const row2 = document.querySelector<HTMLElement>('[data-sidebar-virtual-row="chat-2"]');
		if (!row0 || !row2) throw new Error('expected test rows to be rendered');

		vi.spyOn(viewport, 'getBoundingClientRect').mockReturnValue(
			rect({ left: 0, top: 0, width: 320, height: 640 }),
		);
		vi.spyOn(row2, 'getBoundingClientRect').mockReturnValue(
			rect({ left: 0, top: rowHeight * 2, width: 320, height: rowHeight }),
		);

		let elementAtPoint: HTMLElement | null = row2;
		vi.spyOn(document, 'elementFromPoint').mockImplementation(() => elementAtPoint);

		await fireEvent.touchStart(row0, {
			touches: [touchAt(1, 20, 44)],
			changedTouches: [touchAt(1, 20, 44)],
		});
		vi.advanceTimersByTime(370);
		await tick();

		const targetY = rowHeight * 2 + rowHeight * 0.75;
		await fireEvent.touchMove(window, {
			touches: [touchAt(1, 20, targetY)],
			changedTouches: [touchAt(1, 20, targetY)],
		});
		await tick();

		elementAtPoint = document.querySelector<HTMLElement>('[data-sidebar-virtual-row="chat-0"]');
		await fireEvent.touchEnd(window, {
			touches: [],
			changedTouches: [touchAt(1, 20, targetY)],
		});
		await tick();

		expect(onQuickMove).toHaveBeenCalledTimes(1);
		expect(onQuickMove.mock.calls[0]?.slice(0, 3)).toEqual([
			'normal',
			'chat-0',
			{ kind: 'relative', referenceChatId: 'chat-2', position: 'after' },
		]);
	});

	it('does not persist touch drags across project scopes', async () => {
		vi.useFakeTimers();
		const persist = vi.fn();
		const rows = [
			makeScopedRow(0, '/tmp/project-a', ['chat-0']),
			makeScopedRow(1, '/tmp/project-b', ['chat-1']),
		];

		render(SidebarVirtualSortableChatListHost, {
			rows,
			isMobile: true,
			rowHeight,
			displayOptions: {
				grouping: 'project',
				groupNestedProjectPaths: false,
				chatItemLayout: 'default',
				sortMode: 'manual',
			},
			onPersistReorder: persist,
		});
		await tick();
		const { row0 } = installTouchGeometry();

		await fireEvent.touchStart(row0, {
			touches: [touchAt(1, 20, 44)],
			changedTouches: [touchAt(1, 20, 44)],
		});
		vi.advanceTimersByTime(370);
		await tick();
		await fireEvent.touchMove(window, {
			touches: [touchAt(1, 20, 150)],
			changedTouches: [touchAt(1, 20, 150)],
		});
		await tick();
		await fireEvent.touchEnd(window, {
			touches: [],
			changedTouches: [touchAt(1, 20, 150)],
		});
		await tick();

		expect(persist).not.toHaveBeenCalled();
	});

	it('does not reuse the last touch drop target over a mounted project header', async () => {
		vi.useFakeTimers();
		const persist = vi.fn();
		const rows: SidebarVirtualRow[] = [
			makeScopedRow(0, '/tmp/project-a', ['chat-0', 'chat-1']),
			makeScopedRow(1, '/tmp/project-a', ['chat-0', 'chat-1']),
			makeProjectHeader('/tmp/project-b', 1),
			makeScopedRow(2, '/tmp/project-b', ['chat-2']),
		];

		render(SidebarVirtualSortableChatListHost, {
			rows,
			isMobile: true,
			rowHeight,
			displayOptions: {
				grouping: 'project',
				groupNestedProjectPaths: false,
				chatItemLayout: 'default',
				sortMode: 'manual',
			},
			onPersistReorder: persist,
		});
		await tick();

		const viewport = screen.getByTestId('virtual-sidebar-viewport');
		const row0 = document.querySelector<HTMLElement>('[data-sidebar-virtual-row="chat-0"]');
		const row1 = document.querySelector<HTMLElement>('[data-sidebar-virtual-row="chat-1"]');
		const header = document.querySelector<HTMLElement>(
			'[data-sidebar-project-header="/tmp/project-b"]',
		);
		if (!row0 || !row1 || !header) throw new Error('expected rows and project header');

		vi.spyOn(viewport, 'getBoundingClientRect').mockReturnValue(
			rect({ left: 0, top: 0, width: 320, height: 640 }),
		);
		vi.spyOn(row0, 'getBoundingClientRect').mockReturnValue(
			rect({ left: 0, top: 0, width: 320, height: rowHeight }),
		);
		vi.spyOn(row1, 'getBoundingClientRect').mockReturnValue(
			rect({ left: 0, top: rowHeight, width: 320, height: rowHeight }),
		);
		vi.spyOn(document, 'elementFromPoint').mockImplementation((_, y) => {
			if (y >= rowHeight * 2 && y < rowHeight * 2 + PROJECT_HEADER_ROW_HEIGHT) return header;
			return y >= rowHeight ? row1 : row0;
		});

		await fireEvent.touchStart(row0, {
			touches: [touchAt(1, 20, 44)],
			changedTouches: [touchAt(1, 20, 44)],
		});
		vi.advanceTimersByTime(370);
		await tick();
		await fireEvent.touchMove(window, {
			touches: [touchAt(1, 20, 150)],
			changedTouches: [touchAt(1, 20, 150)],
		});
		await tick();
		await fireEvent.touchEnd(window, {
			touches: [],
			changedTouches: [touchAt(1, 20, rowHeight * 2 + PROJECT_HEADER_ROW_HEIGHT / 2)],
		});
		await tick();

		expect(persist).not.toHaveBeenCalled();
	});

	it('does not persist when a touch drag returns to the original adjacent slot', async () => {
		vi.useFakeTimers();
		const persist = vi.fn();

		render(SidebarVirtualSortableChatListHost, {
			rows: makeRows(20),
			isMobile: true,
			rowHeight,
			onPersistReorder: persist,
		});
		await tick();
		const { row0 } = installTouchGeometry();

		await fireEvent.touchStart(row0, {
			touches: [touchAt(1, 20, 44)],
			changedTouches: [touchAt(1, 20, 44)],
		});
		vi.advanceTimersByTime(370);
		await tick();
		await fireEvent.touchMove(window, {
			touches: [touchAt(1, 20, 150)],
			changedTouches: [touchAt(1, 20, 150)],
		});
		await tick();
		await fireEvent.touchMove(window, {
			touches: [touchAt(1, 20, 100)],
			changedTouches: [touchAt(1, 20, 100)],
		});
		await tick();
		await fireEvent.touchEnd(window, {
			touches: [],
			changedTouches: [touchAt(1, 20, 100)],
		});
		await tick();

		expect(persist).not.toHaveBeenCalled();
	});

	it('does not reuse the last touch drop target when dropping over the dragged row', async () => {
		vi.useFakeTimers();
		const persist = vi.fn();

		render(SidebarVirtualSortableChatListHost, {
			rows: makeRows(20),
			isMobile: true,
			rowHeight,
			onPersistReorder: persist,
		});
		await tick();
		const { row0 } = installTouchGeometry();

		await fireEvent.touchStart(row0, {
			touches: [touchAt(1, 20, 44)],
			changedTouches: [touchAt(1, 20, 44)],
		});
		vi.advanceTimersByTime(370);
		await tick();
		await fireEvent.touchMove(window, {
			touches: [touchAt(1, 20, 150)],
			changedTouches: [touchAt(1, 20, 150)],
		});
		await tick();
		await fireEvent.touchMove(window, {
			touches: [touchAt(1, 20, 44)],
			changedTouches: [touchAt(1, 20, 44)],
		});
		await tick();
		await fireEvent.touchEnd(window, {
			touches: [],
			changedTouches: [touchAt(1, 20, 44)],
		});
		await tick();

		expect(persist).not.toHaveBeenCalled();
	});

	it('suppresses document text selection while a touch long press is pending', async () => {
		vi.useFakeTimers();

		render(SidebarVirtualSortableChatListHost, {
			rows: makeRows(20),
			isMobile: true,
			rowHeight,
		});
		await tick();
		const { row0 } = installTouchGeometry();

		await fireEvent.touchStart(row0, {
			touches: [touchAt(1, 20, 44)],
			changedTouches: [touchAt(1, 20, 44)],
		});
		expect(document.body.style.getPropertyValue('user-select')).toBe('none');
		expect(document.body.style.getPropertyValue('-webkit-user-select')).toBe('none');
		expect(document.body.style.getPropertyValue('-webkit-touch-callout')).toBe('none');
		expect(document.documentElement.style.getPropertyValue('user-select')).toBe('none');
		expect(row0.className).toContain('select-none');

		await fireEvent.touchMove(window, {
			touches: [touchAt(1, 20, 61)],
			changedTouches: [touchAt(1, 20, 61)],
		});
		await tick();

		expect(document.body.style.getPropertyValue('user-select')).toBe('');
		expect(document.body.style.getPropertyValue('-webkit-user-select')).toBe('');
		expect(document.body.style.getPropertyValue('-webkit-touch-callout')).toBe('');
		expect(document.documentElement.style.getPropertyValue('user-select')).toBe('');
	});

	it('clears existing text selection when a touch long press drag activates', async () => {
		vi.useFakeTimers();
		const selection = window.getSelection();
		if (!selection) throw new Error('expected selection API');
		const clearSelection = vi.spyOn(selection, 'removeAllRanges');

		render(SidebarVirtualSortableChatListHost, {
			rows: makeRows(20),
			isMobile: true,
			rowHeight,
		});
		await tick();
		const { row0 } = installTouchGeometry();

		await fireEvent.touchStart(row0, {
			touches: [touchAt(1, 20, 44)],
			changedTouches: [touchAt(1, 20, 44)],
		});
		vi.advanceTimersByTime(370);
		await tick();

		expect(clearSelection).toHaveBeenCalled();
		await fireEvent.touchCancel(window, {
			touches: [],
			changedTouches: [touchAt(1, 20, 44)],
		});
	});

	it('allows normal scroll gestures before the touch long press threshold', async () => {
		vi.useFakeTimers();
		const persist = vi.fn();

		render(SidebarVirtualSortableChatListHost, {
			rows: makeRows(20),
			isMobile: true,
			rowHeight,
			onPersistReorder: persist,
		});
		await tick();
		const { row0 } = installTouchGeometry();

		await fireEvent.touchStart(row0, {
			touches: [touchAt(1, 20, 44)],
			changedTouches: [touchAt(1, 20, 44)],
		});
		await fireEvent.touchMove(window, {
			touches: [touchAt(1, 20, 61)],
			changedTouches: [touchAt(1, 20, 61)],
		});
		vi.advanceTimersByTime(400);
		await fireEvent.touchEnd(window, {
			touches: [],
			changedTouches: [touchAt(1, 20, 61)],
		});
		await tick();

		expect(persist).not.toHaveBeenCalled();
	});

	it('uses virtual rendering for large normal chat lists', () => {
		render(SidebarChatListHost, {
			chats: Array.from({ length: 120 }, (_, index) => makeChat(index)),
		});

		expect(document.querySelector('[data-sidebar-virtual-list]')).toBeTruthy();
		expect(document.querySelectorAll('[data-sidebar-virtual-row]').length).toBeLessThan(40);
		expect(screen.getByText('Chat 0')).toBeTruthy();
		expect(screen.queryByText('Chat 119')).toBeNull();
	});

	it('uses virtual rendering for filtered chat lists', () => {
		const chats = Array.from({ length: 160 }, (_, index) => makeChat(index));
		render(SidebarChatListHost, {
			chats,
			filteredChats: chats.slice(0, 120),
			searchFilter: 'Chat',
		});

		expect(document.querySelector('[data-sidebar-virtual-list]')).toBeTruthy();
		expect(
			document.querySelector('[data-sidebar-virtual-list]')?.getAttribute('data-sidebar-filtered'),
		).toBe('true');
		expect(document.querySelectorAll('[data-sidebar-virtual-row]').length).toBeLessThan(40);
		expect(screen.getByText('Chat 0')).toBeTruthy();
		expect(screen.queryByText('Chat 119')).toBeNull();
	});

	it('uses virtual rendering for small normal chat lists', () => {
		render(SidebarChatListHost, {
			chats: Array.from({ length: 20 }, (_, index) => makeChat(index)),
		});

		expect(document.querySelector('[data-sidebar-virtual-list]')).toBeTruthy();
		expect(screen.getByText('Chat 0')).toBeTruthy();
	});
});
