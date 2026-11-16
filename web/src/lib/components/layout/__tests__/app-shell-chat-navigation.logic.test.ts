import { describe, expect, it } from 'vitest';
import type { ChatSessionRecord } from '$lib/chat/sessions/chat-session-types';
import {
	buildSidebarChatListProjection,
	sidebarGroupCollapseKey,
} from '../../../sidebar/display/sidebar-row-model';
import { resolveAdjacentChatId, shouldSynchronizeFocusedChat } from '../app-shell-chat-navigation';
import { projectionInput, delegated } from '$lib/sidebar/display/__tests__/sidebar-fixtures';

function chat(
	id: string,
	options: Partial<Pick<ChatSessionRecord, 'isPinned' | 'isArchived' | 'lastActivityAt'>> = {},
): ChatSessionRecord {
	return {
		id,
		parentChat: null,
		projectPath: '/repo',
		orderGroup: 'normal',
		title: id,
		agentId: 'claude',
		model: 'sonnet',
		permissionMode: 'default',
		thinkingMode: 'none',
		agentSettings: { ownerId: 'claude', schemaVersion: 1, values: {} },
		createdAt: null,
		lastActivityAt: options.lastActivityAt ?? null,
		lastReadAt: null,
		isPinned: options.isPinned ?? false,
		isArchived: options.isArchived ?? false,
		isProcessing: false,
		processingPhase: null,
		isUnread: false,
		activityStatus: null,
		canReloadFromNativeHistory: false,
		status: 'running',
		agentOwnershipEpoch: 'epoch-1',
		tags: [],
	};
}

describe('resolveAdjacentChatId', () => {
	it.each([false, true])(
		'anchors hidden selections on collapsed group headers (child scope=%s)',
		(nested) => {
			const chats = nested
				? [
						chat('parent'),
						delegated('before', 'parent', { executorId: 'a' }),
						delegated('selected', 'parent', { executorId: 'b' }),
						delegated('after', 'parent', { executorId: 'c' }),
					]
				: ['before', 'selected', 'after'].map((id, index) => ({
						...chat(id),
						executorId: ['a', 'b', 'c'][index],
					}));
			const { rowModel } = buildSidebarChatListProjection(
				projectionInput(chats, {
					groupingFields: [{ field: 'executor', enabled: true }],
					executorOrder: ['local', 'a', 'b', 'c'],
					collapsedProjectKeys: new Set([
						sidebarGroupCollapseKey(nested ? 'parent' : null, [['executor', 'b']]),
					]),
				}),
			);
			expect(rowModel.visibleChatIds).not.toContain('selected');
			for (const offset of [-1, 1] as const) {
				expect(
					resolveAdjacentChatId({
						selectedChatId: 'selected',
						displayedChatIds: rowModel.visibleChatIds,
						displayedRows: rowModel.rows,
						fallbackOrder: [],
						offset,
					}),
				).toBe(offset === -1 ? 'before' : 'after');
			}
		},
	);
	it('anchors a hidden selected descendant on its visible collapsed parent', () => {
		const chats = [
			chat('before'),
			chat('parent'),
			{ ...chat('child'), parentChat: { chatId: 'parent', relation: 'delegation' as const } },
			chat('after'),
		];
		const { rowModel } = buildSidebarChatListProjection({
			allChats: chats,
			groupingFields: [],
			nestDelegatedChats: true,
			collapsedProjectKeys: new Set(['delegation:parent']),
			currentTime: new Date('2026-01-01'),
			inactivityDuration: '3-days',
			sortMode: 'manual',
			pinnedInsertPosition: 'top',
		});
		expect(rowModel.visibleChatIds).toEqual(['before', 'parent', 'after']);
		for (const offset of [-1, 1] as const) {
			expect(
				resolveAdjacentChatId({
					selectedChatId: 'child',
					displayedChatIds: rowModel.visibleChatIds,
					displayedRows: rowModel.rows,
					fallbackOrder: [],
					offset,
				}),
			).toBe(offset === -1 ? 'before' : 'after');
		}
		expect(
			resolveAdjacentChatId({
				selectedChatId: 'missing',
				displayedChatIds: rowModel.visibleChatIds,
				displayedRows: rowModel.rows,
				fallbackOrder: ['missing', 'after'],
				offset: 1,
			}),
		).toBeNull();
	});

	it.each([false, true])(
		'follows configured executor order with a collapsed executor=%s',
		(collapsed) => {
			const chats = [
				{ ...chat('remote-a'), executorId: 'worker-a' },
				chat('local'),
				{ ...chat('remote-b'), executorId: 'worker-b' },
			];
			const { rowModel } = buildSidebarChatListProjection({
				allChats: chats,
				executorOrder: ['local', 'worker-b', 'worker-a'],
				collapsedProjectKeys: new Set(
					collapsed ? [sidebarGroupCollapseKey(null, [['executor', 'worker-b']])] : [],
				),
				groupingFields: [
					{ field: 'executor', enabled: true },
					{ field: 'project', enabled: true },
				],
				nestDelegatedChats: false,
				currentTime: new Date('2025-06-01T12:00:00.000Z'),
				inactivityDuration: '3-days',
				sortMode: 'manual',
				pinnedInsertPosition: 'top',
			});
			expect(rowModel.visibleChatIds).toEqual(
				collapsed ? ['local', 'remote-a'] : ['local', 'remote-b', 'remote-a'],
			);
			expect(
				resolveAdjacentChatId({
					selectedChatId: 'local',
					displayedChatIds: rowModel.visibleChatIds,
					fallbackOrder: chats.map((entry) => entry.id),
					offset: 1,
				}),
			).toBe(collapsed ? 'remote-a' : 'remote-b');
		},
	);

	it('follows displayed sidebar order when pinned chats are hoisted', () => {
		const chats = [chat('normal-a'), chat('normal-b'), chat('pinned-c', { isPinned: true })];
		const displayedChatIds = buildSidebarChatListProjection({
			allChats: chats,
			groupingFields: [],
			nestDelegatedChats: false,
			currentTime: new Date('2025-06-01T12:00:00.000Z'),
			inactivityDuration: '3-days',
			sortMode: 'manual',
			pinnedInsertPosition: 'top',
		}).rowModel.visibleChatIds;

		expect(displayedChatIds).toEqual(['pinned-c', 'normal-a', 'normal-b']);
		expect(
			resolveAdjacentChatId({
				selectedChatId: 'normal-a',
				displayedChatIds,
				fallbackOrder: ['normal-a', 'normal-b', 'pinned-c'],
				offset: -1,
			}),
		).toBe('pinned-c');
	});

	it('follows activity sections and the configured inactivity duration', () => {
		const chats = [
			chat('inactive-a'),
			chat('active-b', { lastActivityAt: '2025-05-22T12:00:00.000Z' }),
			chat('pinned-c', { isPinned: true }),
			chat('archived-d', { isArchived: true }),
		];
		const input = {
			allChats: chats,
			groupingFields: [{ field: 'activity' as const, enabled: true }],
			nestDelegatedChats: false,
			currentTime: new Date('2025-06-01T12:00:00.000Z'),
			sortMode: 'manual',
			pinnedInsertPosition: 'top',
		} as const;

		expect(
			buildSidebarChatListProjection({ ...input, inactivityDuration: '2-weeks' }).rowModel
				.visibleChatIds,
		).toEqual(['pinned-c', 'active-b', 'inactive-a', 'archived-d']);
		expect(
			buildSidebarChatListProjection({ ...input, inactivityDuration: '5-days' }).rowModel
				.visibleChatIds,
		).toEqual(['pinned-c', 'inactive-a', 'active-b', 'archived-d']);
	});

	it('follows recent activity order within an activity section', () => {
		const displayedChatIds = buildSidebarChatListProjection({
			allChats: [
				chat('older', { lastActivityAt: '2025-05-30T12:00:00.000Z' }),
				chat('newer', { lastActivityAt: '2025-05-31T12:00:00.000Z' }),
			],
			groupingFields: [{ field: 'activity' as const, enabled: true }],
			nestDelegatedChats: false,
			currentTime: new Date('2025-06-01T12:00:00.000Z'),
			inactivityDuration: '3-days',
			sortMode: 'recent',
			pinnedInsertPosition: 'top',
		}).rowModel.visibleChatIds;

		expect(displayedChatIds).toEqual(['newer', 'older']);
		expect(
			resolveAdjacentChatId({
				selectedChatId: 'newer',
				displayedChatIds,
				fallbackOrder: ['older', 'newer'],
				offset: 1,
			}),
		).toBe('older');
	});

	it('follows oldest-first pinned activity when pins are added at the bottom', () => {
		const displayedChatIds = buildSidebarChatListProjection({
			allChats: [
				chat('pinned-newer', {
					isPinned: true,
					lastActivityAt: '2025-05-31T12:00:00.000Z',
				}),
				chat('normal-newer', { lastActivityAt: '2025-05-31T12:00:00.000Z' }),
				chat('pinned-older', {
					isPinned: true,
					lastActivityAt: '2025-05-30T12:00:00.000Z',
				}),
				chat('normal-older', { lastActivityAt: '2025-05-30T12:00:00.000Z' }),
			],
			groupingFields: [],
			nestDelegatedChats: false,
			currentTime: new Date('2025-06-01T12:00:00.000Z'),
			inactivityDuration: '3-days',
			sortMode: 'recent',
			pinnedInsertPosition: 'bottom',
		}).rowModel.visibleChatIds;

		expect(displayedChatIds).toEqual([
			'pinned-older',
			'pinned-newer',
			'normal-newer',
			'normal-older',
		]);
		expect(
			resolveAdjacentChatId({
				selectedChatId: 'pinned-older',
				displayedChatIds,
				fallbackOrder: [],
				offset: 1,
			}),
		).toBe('pinned-newer');
	});

	it('falls back to raw session order when the sidebar is unmounted', () => {
		expect(
			resolveAdjacentChatId({
				selectedChatId: 'normal-b',
				displayedChatIds: null,
				fallbackOrder: ['normal-a', 'normal-b', 'pinned-c'],
				offset: -1,
			}),
		).toBe('normal-a');
	});

	it('does not fall back when the mounted sidebar has filtered out the selected chat', () => {
		expect(
			resolveAdjacentChatId({
				selectedChatId: 'normal-a',
				displayedChatIds: ['normal-b'],
				fallbackOrder: ['normal-a', 'normal-b'],
				offset: 1,
			}),
		).toBeNull();
	});
});

describe('shouldSynchronizeFocusedChat', () => {
	it('does not let stale focus replace an explicit Chat navigation in flight', () => {
		expect(
			shouldSynchronizeFocusedChat({
				focusedWindowId: 'window-main',
				focusedChatId: 'chat-old',
				focusedChatExists: true,
				selectedChatId: null,
				pendingChatTarget: 'chat-route',
				pendingWindowId: 'window-main',
			}),
		).toBe(false);
	});

	it('lets a newly focused window supersede an older navigation in flight', () => {
		expect(
			shouldSynchronizeFocusedChat({
				focusedWindowId: 'window-other',
				focusedChatId: 'chat-focused',
				focusedChatExists: true,
				selectedChatId: 'chat-selected',
				pendingChatTarget: 'chat-route',
				pendingWindowId: 'window-main',
			}),
		).toBe(true);
	});

	it('keeps navigation pending when its Chat is reused in another window', () => {
		expect(
			shouldSynchronizeFocusedChat({
				focusedWindowId: 'window-existing',
				focusedChatId: 'chat-route',
				focusedChatExists: true,
				selectedChatId: 'chat-selected',
				pendingChatTarget: 'chat-route',
				pendingWindowId: 'window-main',
			}),
		).toBe(false);
	});

	it('synchronizes a changed focused Chat after explicit navigation settles', () => {
		expect(
			shouldSynchronizeFocusedChat({
				focusedWindowId: 'window-main',
				focusedChatId: 'chat-focused',
				focusedChatExists: true,
				selectedChatId: 'chat-selected',
				pendingChatTarget: null,
				pendingWindowId: null,
			}),
		).toBe(true);
	});

	it('does not reselect a focused Chat after its session is deleted', () => {
		expect(
			shouldSynchronizeFocusedChat({
				focusedWindowId: 'window-main',
				focusedChatId: 'chat-deleted',
				focusedChatExists: false,
				selectedChatId: null,
				pendingChatTarget: null,
				pendingWindowId: null,
			}),
		).toBe(false);
	});
});
