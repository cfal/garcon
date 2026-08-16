import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	AssistantMessage,
	BashToolUseMessage,
	ExternalToolUseMessage,
	McpToolUseMessage,
	PermissionRequestMessage,
	ToolResultMessage,
	UnknownToolUseMessage,
	UserMessage,
	WaitToolUseMessage,
	type ChatMessage,
} from '$shared/chat-types';
import {
	announcementForAppendedRow,
	CHAT_FEED_ANNOUNCEMENT_BATCH_MS,
	ConversationFeedAnnouncementBatcher,
	ConversationFeedAnnouncerState,
	plainAnnouncementText,
} from '../conversation-feed-announcer';
import type { ConversationFeedMutationClock } from '$lib/chat/transcript/conversation-feed-mutations';

function clock(
	dataRevision: number,
	liveAppendRevision = 0,
	presentationRevision = 0,
	responseRevisions: Readonly<Record<string, number>> = liveAppendRevision > 0
		? { 'assistant-message': liveAppendRevision }
		: {},
): ConversationFeedMutationClock {
	return {
		dataRevision,
		lastResponseRevisionByMessageType: responseRevisions,
		lastRevisionByKind: {
			initial: 0,
			'live-append': liveAppendRevision,
			'history-earlier': 0,
			'history-later': 0,
			replacement: 0,
			'presentation-structure': presentationRevision,
		},
	};
}

function assistantRow(id: string, content: string) {
	return {
		kind: 'message' as const,
		id,
		seq: Number(id),
		message: new AssistantMessage('2026-01-01T00:00:00.000Z', content),
	};
}

function messageRow(id: string, message: ChatMessage) {
	return { kind: 'message' as const, id, seq: Number(id), message };
}

const enabled = {
	visible: true,
	pinnedToBottom: true,
	isLiveWindow: true,
	detachedStatus: 'New response available',
	hiddenToolTypes: [] as string[],
	floatingPermissionOccurrences: [] as string[],
};

describe('ConversationFeedAnnouncerState', () => {
	it('does not announce the initial or replacement transcript', () => {
		const announcer = new ConversationFeedAnnouncerState();
		expect(
			announcer.reconcile({
				surfaceIdentity: 'chat:generation',
				rows: [assistantRow('1', 'existing')],
				mutationClock: clock(1),
				...enabled,
			}),
		).toBe('');
	});

	it('announces only newly appended visible conversation text at the live end', () => {
		const announcer = new ConversationFeedAnnouncerState();
		announcer.reconcile({
			surfaceIdentity: 'chat:generation',
			rows: [assistantRow('1', 'existing')],
			mutationClock: clock(1),
			...enabled,
		});
		expect(
			announcer.reconcile({
				surfaceIdentity: 'chat:generation',
				rows: [assistantRow('1', 'existing'), assistantRow('2', 'new response')],
				mutationClock: clock(2, 2),
				...enabled,
			}),
		).toBe('new response');
	});

	it('acknowledges hidden and detached appends without replaying them later', () => {
		const announcer = new ConversationFeedAnnouncerState();
		announcer.reconcile({
			surfaceIdentity: 'chat:generation',
			rows: [assistantRow('1', 'existing')],
			mutationClock: clock(1),
			...enabled,
		});
		expect(
			announcer.reconcile({
				surfaceIdentity: 'chat:generation',
				rows: [assistantRow('1', 'existing'), assistantRow('2', 'while detached')],
				mutationClock: clock(2, 2),
				...enabled,
				visible: false,
				pinnedToBottom: false,
			}),
		).toBe('');
		expect(
			announcer.reconcile({
				surfaceIdentity: 'chat:generation',
				rows: [assistantRow('1', 'existing'), assistantRow('2', 'while detached')],
				mutationClock: clock(2, 2),
				...enabled,
			}),
		).toBeNull();
	});

	it('emits one concise status while visibly detached', () => {
		const announcer = new ConversationFeedAnnouncerState();
		announcer.reconcile({
			surfaceIdentity: 'chat:generation',
			rows: [assistantRow('1', 'existing')],
			mutationClock: clock(1),
			...enabled,
		});
		expect(
			announcer.reconcile({
				surfaceIdentity: 'chat:generation',
				rows: [assistantRow('1', 'existing'), assistantRow('2', 'first unseen response')],
				mutationClock: clock(2, 2),
				...enabled,
				pinnedToBottom: false,
			}),
		).toBe('New response available');
		expect(
			announcer.reconcile({
				surfaceIdentity: 'chat:generation',
				rows: [
					assistantRow('1', 'existing'),
					assistantRow('2', 'first unseen response'),
					assistantRow('3', 'second unseen response'),
				],
				mutationClock: clock(3, 3),
				...enabled,
				pinnedToBottom: false,
			}),
		).toBeNull();
		expect(
			announcer.reconcile({
				surfaceIdentity: 'chat:generation',
				rows: [
					assistantRow('1', 'existing'),
					assistantRow('2', 'first unseen response'),
					assistantRow('3', 'second unseen response'),
				],
				mutationClock: clock(3, 3),
				...enabled,
			}),
		).toBe('');
	});

	it('announces live responses and permissions while viewing an older window', () => {
		const announcer = new ConversationFeedAnnouncerState();
		const olderRows = [assistantRow('1', 'older response')];
		announcer.reconcile({
			surfaceIdentity: 'chat:generation',
			rows: olderRows,
			mutationClock: clock(1),
			...enabled,
			pinnedToBottom: false,
			isLiveWindow: false,
		});

		expect(
			announcer.reconcile({
				surfaceIdentity: 'chat:generation',
				rows: olderRows,
				mutationClock: clock(2, 2),
				...enabled,
				pinnedToBottom: false,
				isLiveWindow: false,
			}),
		).toBe('New response available');
		expect(
			announcer.reconcile({
				surfaceIdentity: 'chat:generation',
				rows: olderRows,
				mutationClock: clock(3, 3),
				...enabled,
				pinnedToBottom: false,
				isLiveWindow: false,
			}),
		).toBeNull();

		const permissionAnnouncer = new ConversationFeedAnnouncerState();
		permissionAnnouncer.reconcile({
			surfaceIdentity: 'chat:generation',
			rows: olderRows,
			mutationClock: clock(1),
			...enabled,
			pinnedToBottom: false,
			isLiveWindow: false,
		});
		expect(
			permissionAnnouncer.reconcile({
				surfaceIdentity: 'chat:generation',
				rows: olderRows,
				mutationClock: clock(1),
				...enabled,
				pinnedToBottom: false,
				isLiveWindow: false,
				floatingPermissionOccurrences: ['incarnation-1'],
			}),
		).toBe('New response available');
	});

	it('filters historical response status through the visible tool contract', () => {
		const announcer = new ConversationFeedAnnouncerState();
		const olderRows = [assistantRow('1', 'older response')];
		announcer.reconcile({
			surfaceIdentity: 'chat:generation',
			rows: olderRows,
			mutationClock: clock(1),
			...enabled,
			pinnedToBottom: false,
			isLiveWindow: false,
		});

		expect(
			announcer.reconcile({
				surfaceIdentity: 'chat:generation',
				rows: olderRows,
				mutationClock: clock(2, 2, 0, { 'wait-tool-use': 2 }),
				...enabled,
				pinnedToBottom: false,
				isLiveWindow: false,
			}),
		).toBeNull();
		expect(
			announcer.reconcile({
				surfaceIdentity: 'chat:generation',
				rows: olderRows,
				mutationClock: clock(3, 3, 0, { 'bash-tool-use': 3 }),
				...enabled,
				pinnedToBottom: false,
				isLiveWindow: false,
				hiddenToolTypes: ['bash-tool-use'],
			}),
		).toBeNull();
		expect(
			announcer.reconcile({
				surfaceIdentity: 'chat:generation',
				rows: olderRows,
				mutationClock: clock(4, 4, 0, { 'bash-tool-use': 4 }),
				...enabled,
				pinnedToBottom: false,
				isLiveWindow: false,
			}),
		).toBe('New response available');
	});

	it.each([
		'wait-tool-use',
		'unknown-tool-use',
		'external-tool-use',
		'mcp-tool-use',
		'thinking',
		'error',
	])('does not announce suppressed historical response type %s', (messageType) => {
		const announcer = new ConversationFeedAnnouncerState();
		const olderRows = [assistantRow('1', 'older response')];
		announcer.reconcile({
			surfaceIdentity: 'chat:generation',
			rows: olderRows,
			mutationClock: clock(1),
			...enabled,
			pinnedToBottom: false,
			isLiveWindow: false,
		});

		expect(
			announcer.reconcile({
				surfaceIdentity: 'chat:generation',
				rows: olderRows,
				mutationClock: clock(2, 2, 0, { [messageType]: 2 }),
				...enabled,
				pinnedToBottom: false,
				isLiveWindow: false,
			}),
		).toBeNull();
	});

	it('checks each historical response type against its own revision', () => {
		const announcer = new ConversationFeedAnnouncerState();
		const olderRows = [assistantRow('1', 'older response')];
		announcer.reconcile({
			surfaceIdentity: 'chat:generation',
			rows: olderRows,
			mutationClock: clock(2, 0, 0, { 'assistant-message': 1 }),
			...enabled,
			pinnedToBottom: false,
			isLiveWindow: false,
		});

		expect(
			announcer.reconcile({
				surfaceIdentity: 'chat:generation',
				rows: olderRows,
				mutationClock: clock(3, 3, 0, {
					'assistant-message': 1,
					'wait-tool-use': 3,
				}),
				...enabled,
				pinnedToBottom: false,
				isLiveWindow: false,
			}),
		).toBeNull();
		expect(
			announcer.reconcile({
				surfaceIdentity: 'chat:generation',
				rows: olderRows,
				mutationClock: clock(4, 4, 0, {
					'assistant-message': 4,
					'wait-tool-use': 3,
				}),
				...enabled,
				pinnedToBottom: false,
				isLiveWindow: false,
			}),
		).toBe('New response available');
	});

	it('announces a historical batch containing suppressed and visible response types', () => {
		const announcer = new ConversationFeedAnnouncerState();
		const olderRows = [assistantRow('1', 'older response')];
		announcer.reconcile({
			surfaceIdentity: 'chat:generation',
			rows: olderRows,
			mutationClock: clock(1),
			...enabled,
			pinnedToBottom: false,
			isLiveWindow: false,
		});

		expect(
			announcer.reconcile({
				surfaceIdentity: 'chat:generation',
				rows: olderRows,
				mutationClock: clock(2, 2, 0, {
					'assistant-message': 2,
					'wait-tool-use': 2,
				}),
				...enabled,
				pinnedToBottom: false,
				isLiveWindow: false,
			}),
		).toBe('New response available');
	});

	it('allows a new detached status after returning from a historical window', () => {
		const announcer = new ConversationFeedAnnouncerState();
		const olderRows = [assistantRow('1', 'older response')];
		announcer.reconcile({
			surfaceIdentity: 'chat:generation',
			rows: olderRows,
			mutationClock: clock(1),
			...enabled,
			pinnedToBottom: false,
			isLiveWindow: false,
		});
		expect(
			announcer.reconcile({
				surfaceIdentity: 'chat:generation',
				rows: olderRows,
				mutationClock: clock(2, 2),
				...enabled,
				pinnedToBottom: false,
				isLiveWindow: false,
			}),
		).toBe('New response available');

		expect(
			announcer.reconcile({
				surfaceIdentity: 'chat:generation',
				rows: olderRows,
				mutationClock: clock(2, 2),
				...enabled,
				pinnedToBottom: false,
			}),
		).toBe('');
		expect(
			announcer.reconcile({
				surfaceIdentity: 'chat:generation',
				rows: [...olderRows, assistantRow('2', 'new live response')],
				mutationClock: clock(3, 3),
				...enabled,
				pinnedToBottom: false,
			}),
		).toBe('New response available');
	});

	it('treats visible tool output as a detached response update', () => {
		const announcer = new ConversationFeedAnnouncerState();
		announcer.reconcile({
			surfaceIdentity: 'chat:generation',
			rows: [assistantRow('1', 'existing')],
			mutationClock: clock(1),
			...enabled,
		});
		const firstTool = messageRow('2', new BashToolUseMessage('', 'tool-1', 'pwd'));
		expect(
			announcer.reconcile({
				surfaceIdentity: 'chat:generation',
				rows: [assistantRow('1', 'existing'), firstTool],
				mutationClock: clock(2, 2),
				...enabled,
				pinnedToBottom: false,
			}),
		).toBe('New response available');
		expect(
			announcer.reconcile({
				surfaceIdentity: 'chat:generation',
				rows: [
					assistantRow('1', 'existing'),
					firstTool,
					messageRow('3', new BashToolUseMessage('', 'tool-2', 'ls')),
				],
				mutationClock: clock(3, 3),
				...enabled,
				pinnedToBottom: false,
			}),
		).toBeNull();
	});

	it('does not treat suppressed tool output as a detached response update', () => {
		const announcer = new ConversationFeedAnnouncerState();
		announcer.reconcile({
			surfaceIdentity: 'chat:generation',
			rows: [assistantRow('1', 'existing')],
			mutationClock: clock(1),
			...enabled,
		});
		expect(
			announcer.reconcile({
				surfaceIdentity: 'chat:generation',
				rows: [
					assistantRow('1', 'existing'),
					messageRow('2', new BashToolUseMessage('', 'tool-1', 'pwd')),
				],
				mutationClock: clock(2, 2),
				...enabled,
				pinnedToBottom: false,
				hiddenToolTypes: ['bash-tool-use'],
			}),
		).toBeNull();
	});

	it('announces only the newly streamed suffix at the live end', () => {
		const announcer = new ConversationFeedAnnouncerState();
		announcer.reconcile({
			surfaceIdentity: 'chat:generation',
			rows: [assistantRow('1', 'Hello')],
			mutationClock: clock(1),
			...enabled,
		});
		expect(
			announcer.reconcile({
				surfaceIdentity: 'chat:generation',
				rows: [assistantRow('1', 'Hello world')],
				mutationClock: clock(2, 2),
				...enabled,
			}),
		).toBe('world');
	});

	it('flattens Markdown without exposing formatting punctuation', () => {
		expect(plainAnnouncementText('## See [the file](/tmp/file) and `value`')).toBe(
			'See the file and value',
		);
		expect(plainAnnouncementText('Before\n```ts\nconst value = 1;\n```\nafter')).toBe(
			'Before Code block after',
		);
	});

	it('announces user text, local notices, known tools, and permission requests', () => {
		expect(announcementForAppendedRow(messageRow('1', new UserMessage('', 'hello')), [])).toBe(
			'hello',
		);
		expect(
			announcementForAppendedRow(
				{
					kind: 'local-notice',
					id: 'notice',
					noticeType: 'info',
					content: '**updated**',
					timestamp: '',
				},
				[],
			),
		).toBe('updated');
		expect(
			announcementForAppendedRow(messageRow('2', new BashToolUseMessage('', 'tool-1', 'pwd')), []),
		).toBe('Bash');
		expect(
			announcementForAppendedRow(
				messageRow(
					'3',
					new PermissionRequestMessage(
						'',
						'incarnation-1',
						new BashToolUseMessage('', 'tool-2', 'rm file'),
					),
				),
				[],
			),
		).toBe('Permission required');
	});

	it('suppresses hidden, terminal, unknown, external, MCP, and nonvisual tools', () => {
		expect(
			announcementForAppendedRow(messageRow('1', new BashToolUseMessage('', 'tool-1', 'pwd')), [
				'bash-tool-use',
			]),
		).toBeNull();
		expect(
			announcementForAppendedRow(
				messageRow('2', new WaitToolUseMessage('', 'tool-2', 'execution-1')),
				[],
			),
		).toBeNull();
		expect(
			announcementForAppendedRow(
				messageRow('3', new UnknownToolUseMessage('', 'tool-3', 'secret_provider_name', {})),
				[],
			),
		).toBeNull();
		expect(
			announcementForAppendedRow(
				messageRow('4', new ExternalToolUseMessage('', 'tool-4', 'secret', {}, 'provider')),
				[],
			),
		).toBeNull();
		expect(
			announcementForAppendedRow(
				messageRow('5', new McpToolUseMessage('', 'tool-5', 'server', 'private_tool', {})),
				[],
			),
		).toBeNull();
		expect(
			announcementForAppendedRow(
				messageRow('6', new ToolResultMessage('', 'tool-1', {}, false)),
				[],
			),
		).toBeNull();
	});

	it('announces appended local notices and floating permissions without virtual mount events', () => {
		const announcer = new ConversationFeedAnnouncerState();
		announcer.reconcile({
			surfaceIdentity: 'chat:generation',
			rows: [assistantRow('1', 'existing')],
			mutationClock: clock(1),
			...enabled,
		});
		expect(
			announcer.reconcile({
				surfaceIdentity: 'chat:generation',
				rows: [
					assistantRow('1', 'existing'),
					{
						kind: 'local-notice',
						id: 'notice',
						noticeType: 'info',
						content: 'Working',
						timestamp: '',
					},
				],
				mutationClock: clock(2, 0, 2),
				...enabled,
			}),
		).toBe('Working');
		expect(
			announcer.reconcile({
				surfaceIdentity: 'chat:generation',
				rows: [
					assistantRow('1', 'existing'),
					{
						kind: 'local-notice',
						id: 'notice',
						noticeType: 'info',
						content: 'Working',
						timestamp: '',
					},
				],
				mutationClock: clock(2, 0, 2),
				...enabled,
				floatingPermissionOccurrences: ['incarnation-1'],
			}),
		).toBe('Permission required');
	});

	it('announces the newest row when a large live batch trims the previous tail', () => {
		const announcer = new ConversationFeedAnnouncerState();
		announcer.reconcile({
			surfaceIdentity: 'chat:generation',
			rows: [assistantRow('1', 'existing')],
			mutationClock: clock(1),
			...enabled,
		});
		const replacementWindow = Array.from({ length: 200 }, (_, index) =>
			assistantRow(String(index + 2), `response ${index + 2}`),
		);
		expect(
			announcer.reconcile({
				surfaceIdentity: 'chat:generation',
				rows: replacementWindow,
				mutationClock: clock(2, 2),
				...enabled,
			}),
		).toBe('response 201');
	});

	it('does not repeat a pending user message when its durable echo replaces it', () => {
		const announcer = new ConversationFeedAnnouncerState();
		announcer.reconcile({
			surfaceIdentity: 'chat:generation',
			rows: [assistantRow('1', 'existing')],
			mutationClock: clock(1),
			...enabled,
		});
		const pending = messageRow(
			'2',
			new UserMessage('', 'send once', undefined, { clientRequestId: 'request-1' }),
		);
		expect(
			announcer.reconcile({
				surfaceIdentity: 'chat:generation',
				rows: [assistantRow('1', 'existing'), pending],
				mutationClock: clock(2, 0, 2),
				...enabled,
			}),
		).toBe('send once');
		const durable = { ...pending, id: '3', ordinal: 3 };
		expect(
			announcer.reconcile({
				surfaceIdentity: 'chat:generation',
				rows: [assistantRow('1', 'existing'), durable],
				mutationClock: clock(3, 3, 2),
				...enabled,
			}),
		).toBeNull();
	});

	it('does not repeat a floating permission when its transcript row replaces it', () => {
		const announcer = new ConversationFeedAnnouncerState();
		announcer.reconcile({
			surfaceIdentity: 'chat:generation',
			rows: [assistantRow('1', 'existing')],
			mutationClock: clock(1),
			...enabled,
		});
		expect(
			announcer.reconcile({
				surfaceIdentity: 'chat:generation',
				rows: [assistantRow('1', 'existing')],
				mutationClock: clock(2, 0, 2),
				...enabled,
				floatingPermissionOccurrences: ['incarnation-1'],
			}),
		).toBe('Permission required');
		const permission = messageRow(
			'2',
			new PermissionRequestMessage(
				'',
				'incarnation-1',
				new BashToolUseMessage('', 'tool-1', 'pwd'),
			),
		);
		expect(
			announcer.reconcile({
				surfaceIdentity: 'chat:generation',
				rows: [assistantRow('1', 'existing'), permission],
				mutationClock: clock(3, 3, 2),
				...enabled,
			}),
		).toBeNull();
	});

	it('announces distinct permission occurrences independently', () => {
		const announcer = new ConversationFeedAnnouncerState();
		const existing = assistantRow('1', 'existing');
		const first = messageRow(
			'2',
			new PermissionRequestMessage(
				'',
				'incarnation-1',
				new BashToolUseMessage('', 'tool-1', 'printf first'),
			),
		);
		const second = messageRow(
			'3',
			new PermissionRequestMessage(
				'',
				'incarnation-2',
				new BashToolUseMessage('', 'tool-2', 'printf second'),
			),
		);
		announcer.reconcile({
			surfaceIdentity: 'chat:generation',
			rows: [existing],
			mutationClock: clock(1),
			...enabled,
		});

		expect(
			announcer.reconcile({
				surfaceIdentity: 'chat:generation',
				rows: [existing, first],
				mutationClock: clock(2, 2, 2),
				...enabled,
			}),
		).toBe('Permission required');
		expect(
			announcer.reconcile({
				surfaceIdentity: 'chat:generation',
				rows: [existing, first, second],
				mutationClock: clock(3, 3, 2),
				...enabled,
			}),
		).toBe('Permission required');
	});

	it('does not replay a hidden pending user message after its durable echo arrives', () => {
		const announcer = new ConversationFeedAnnouncerState();
		announcer.reconcile({
			surfaceIdentity: 'chat:generation',
			rows: [assistantRow('1', 'existing')],
			mutationClock: clock(1),
			...enabled,
		});
		const pending = messageRow(
			'2',
			new UserMessage('', 'send once', undefined, { clientRequestId: 'request-1' }),
		);
		expect(
			announcer.reconcile({
				surfaceIdentity: 'chat:generation',
				rows: [assistantRow('1', 'existing'), pending],
				mutationClock: clock(2, 0, 2),
				...enabled,
				visible: false,
			}),
		).toBe('');
		expect(
			announcer.reconcile({
				surfaceIdentity: 'chat:generation',
				rows: [assistantRow('1', 'existing'), pending],
				mutationClock: clock(2, 0, 2),
				...enabled,
			}),
		).toBeNull();
		expect(
			announcer.reconcile({
				surfaceIdentity: 'chat:generation',
				rows: [assistantRow('1', 'existing'), { ...pending, id: '3', ordinal: 3 }],
				mutationClock: clock(3, 3, 2),
				...enabled,
			}),
		).toBeNull();
	});

	it('does not replay a hidden floating permission after its transcript row arrives', () => {
		const announcer = new ConversationFeedAnnouncerState();
		announcer.reconcile({
			surfaceIdentity: 'chat:generation',
			rows: [assistantRow('1', 'existing')],
			mutationClock: clock(1),
			...enabled,
		});
		expect(
			announcer.reconcile({
				surfaceIdentity: 'chat:generation',
				rows: [assistantRow('1', 'existing')],
				mutationClock: clock(2, 0, 2),
				...enabled,
				visible: false,
				floatingPermissionOccurrences: ['incarnation-1'],
			}),
		).toBe('');
		expect(
			announcer.reconcile({
				surfaceIdentity: 'chat:generation',
				rows: [assistantRow('1', 'existing')],
				mutationClock: clock(2, 0, 2),
				...enabled,
				floatingPermissionOccurrences: ['incarnation-1'],
			}),
		).toBeNull();
		const permission = messageRow(
			'2',
			new PermissionRequestMessage(
				'',
				'incarnation-1',
				new BashToolUseMessage('', 'tool-1', 'pwd'),
			),
		);
		expect(
			announcer.reconcile({
				surfaceIdentity: 'chat:generation',
				rows: [assistantRow('1', 'existing'), permission],
				mutationClock: clock(3, 3, 2),
				...enabled,
			}),
		).toBeNull();
	});

	it('retains an active floating permission lineage at the bounded history limit', () => {
		const announcer = new ConversationFeedAnnouncerState();
		announcer.reconcile({
			surfaceIdentity: 'chat:generation',
			rows: [assistantRow('1', 'existing')],
			mutationClock: clock(1),
			...enabled,
		});
		expect(
			announcer.reconcile({
				surfaceIdentity: 'chat:generation',
				rows: [assistantRow('1', 'existing')],
				mutationClock: clock(2, 0, 2),
				...enabled,
				floatingPermissionOccurrences: ['incarnation-1'],
			}),
		).toBe('Permission required');

		const historicalPermissions = Array.from({ length: 513 }, (_, index) =>
			messageRow(
				String(index + 2),
				new PermissionRequestMessage(
					'',
					`incarnation-history-${index}`,
					new BashToolUseMessage('', `tool-${index}`, 'pwd'),
				),
			),
		);
		expect(
			announcer.reconcile({
				surfaceIdentity: 'chat:generation',
				rows: [assistantRow('1', 'existing'), ...historicalPermissions],
				mutationClock: clock(3, 3, 2),
				...enabled,
				visible: false,
				floatingPermissionOccurrences: ['incarnation-1'],
			}),
		).toBe('');

		const durablePermission = messageRow(
			'515',
			new PermissionRequestMessage(
				'',
				'incarnation-1',
				new BashToolUseMessage('', 'tool-active', 'pwd'),
			),
		);
		expect(
			announcer.reconcile({
				surfaceIdentity: 'chat:generation',
				rows: [assistantRow('1', 'existing'), ...historicalPermissions, durablePermission],
				mutationClock: clock(4, 4, 2),
				...enabled,
			}),
		).toBeNull();
	});
});

describe('ConversationFeedAnnouncementBatcher', () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it('batches rapid streamed fragments without splitting words', () => {
		const publish = vi.fn<(text: string) => void>();
		const batcher = new ConversationFeedAnnouncementBatcher(publish);

		batcher.enqueue({
			kind: 'announce',
			chunks: [{ kind: 'stream', rowId: 'assistant-1', source: 'hel' }],
		});
		vi.advanceTimersByTime(100);
		batcher.enqueue({
			kind: 'announce',
			chunks: [{ kind: 'stream', rowId: 'assistant-1', source: 'lo world' }],
		});

		expect(publish).not.toHaveBeenCalled();
		vi.advanceTimersByTime(CHAT_FEED_ANNOUNCEMENT_BATCH_MS - 100);
		expect(publish).toHaveBeenCalledOnce();
		expect(publish).toHaveBeenCalledWith('hello world');
	});

	it('keeps distinct rows and actions as separate semantic chunks', () => {
		const publish = vi.fn<(text: string) => void>();
		const batcher = new ConversationFeedAnnouncementBatcher(publish);

		batcher.enqueue({
			kind: 'announce',
			chunks: [
				{ kind: 'stream', rowId: 'assistant-1', source: 'First response' },
				{ kind: 'discrete', text: 'Permission required' },
				{ kind: 'stream', rowId: 'assistant-2', source: 'Second response' },
			],
		});
		vi.advanceTimersByTime(CHAT_FEED_ANNOUNCEMENT_BATCH_MS);

		expect(publish).toHaveBeenCalledWith('First response\nPermission required\nSecond response');
	});

	it('cancels queued speech when the announcement surface clears', () => {
		const publish = vi.fn<(text: string) => void>();
		const batcher = new ConversationFeedAnnouncementBatcher(publish);
		batcher.enqueue({
			kind: 'announce',
			chunks: [{ kind: 'stream', rowId: 'assistant-1', source: 'stale response' }],
		});

		batcher.enqueue({ kind: 'clear' });
		expect(publish).toHaveBeenCalledOnce();
		expect(publish).toHaveBeenCalledWith('');
		vi.advanceTimersByTime(CHAT_FEED_ANNOUNCEMENT_BATCH_MS);
		expect(publish).toHaveBeenCalledOnce();
	});
});
