import type { ChatSessionRecord } from '$lib/chat/sessions/chat-session-types';
import type { SidebarRowModelInput } from '../sidebar-row-model';
import { buildSidebarChatOrderMap } from '../sidebar-row-model';
import { defaultSidebarGroupingFields } from '../sidebar-preferences';

export function chat(id: string, overrides: Partial<ChatSessionRecord> = {}): ChatSessionRecord {
	return {
		id,
		title: id,
		parentChat: null,
		projectPath: '/workspace/app',
		executorId: 'local',
		orderGroup: 'normal',
		agentId: 'claude',
		model: null,
		permissionMode: 'default',
		thinkingMode: 'none',
		agentSettings: { ownerId: 'claude', schemaVersion: 1, values: {} },
		createdAt: '2026-01-01T00:00:00.000Z',
		lastActivityAt: '2026-01-01T00:00:00.000Z',
		lastReadAt: null,
		isPinned: false,
		isArchived: false,
		isProcessing: false,
		processingPhase: null,
		canReloadFromNativeHistory: false,
		isUnread: false,
		status: 'running',
		agentOwnershipEpoch: null,
		tags: [],
		...overrides,
	};
}

export function delegated(
	id: string,
	parent: string,
	overrides: Partial<ChatSessionRecord> = {},
): ChatSessionRecord {
	return chat(id, { parentChat: { chatId: parent, relation: 'delegation' }, ...overrides });
}

export function projectionInput(
	chats: ChatSessionRecord[],
	overrides: Partial<SidebarRowModelInput> = {},
): SidebarRowModelInput {
	return {
		allChats: chats,
		orders: buildSidebarChatOrderMap(chats),
		groupingFields: defaultSidebarGroupingFields(),
		nestDelegatedChats: true,
		currentTime: new Date('2026-02-01T12:00:00.000Z'),
		inactivityDuration: '3-days',
		sortMode: 'manual',
		pinnedInsertPosition: 'top',
		...overrides,
	};
}
