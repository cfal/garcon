import { describe, expect, it } from 'vitest';
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
	ConversationFeedAnnouncerState,
	plainAnnouncementText,
} from '../conversation-feed-announcer';
import type { ConversationFeedMutationClock } from '$lib/chat/transcript/conversation-feed-mutations';

function clock(
	dataRevision: number,
	liveAppendRevision = 0,
	presentationRevision = 0,
): ConversationFeedMutationClock {
	return {
		dataRevision,
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
	floatingPermissionIds: [] as string[],
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
						'permission-1',
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
				floatingPermissionIds: ['permission-1'],
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
});
