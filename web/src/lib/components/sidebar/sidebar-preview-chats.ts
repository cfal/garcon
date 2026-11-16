import type { ChatSessionRecord } from '$lib/chat/sessions/chat-session-types';

export const SIDEBAR_PREVIEW_NOW = new Date('2026-11-15T12:00:00.000Z');

const parent: ChatSessionRecord = {
	id: '1794000000000001',
	parentChat: null,
	executorId: 'local',
	projectPath: '/workspace/app',
	orderGroup: 'normal',
	title: 'Release audit',
	agentId: 'claude',
	model: null,
	permissionMode: 'default',
	thinkingMode: 'none',
	agentSettings: { ownerId: 'claude', schemaVersion: 1, values: {} },
	createdAt: '2026-11-01T09:00:00.000Z',
	lastActivityAt: '2026-11-01T10:00:00.000Z',
	lastReadAt: null,
	isPinned: false,
	isArchived: false,
	isProcessing: false,
	processingPhase: null,
	canReloadFromNativeHistory: false,
	isUnread: false,
	status: 'running',
	agentOwnershipEpoch: null,
	lastMessage: 'Release checklist complete.',
	tags: [],
};

export const SIDEBAR_PREVIEW_CHATS: ChatSessionRecord[] = [
	{
		...parent,
		id: '1794000000000003',
		title: 'Weekly notes',
		projectPath: '/workspace/notes',
		executorId: 'preview-remote',
		lastActivityAt: '2026-11-09T11:00:00.000Z',
		lastMessage: 'Summary ready for review.',
	},
	parent,
	{
		...parent,
		id: '1794000000000002',
		title: 'Investigate failing tests',
		projectPath: '/workspace/app/packages/api',
		parentChat: { chatId: parent.id, relation: 'delegation' },
		isUnread: true,
		lastActivityAt: '2026-11-15T11:45:00.000Z',
		lastMessage: 'The targeted tests now pass.',
	},
];
