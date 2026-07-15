import { describe, expect, it } from 'vitest';
import {
	AssistantMessage,
	AskUserQuestionToolUseMessage,
	BashToolUseMessage,
	ExecToolUseMessage,
	PermissionCancelledMessage,
	PermissionRequestMessage,
	PermissionResolvedMessage,
	ReadToolUseMessage,
	ToolResultMessage,
	UserMessage,
	type ChatMessage,
} from '$shared/chat-types';
import {
	askUserQuestionPermissionId,
	askUserQuestionTerminalFromResult,
	buildConversationFeedRenderItems,
	buildConversationFeedRenderModel,
	filterHiddenToolRenderItems,
	visiblePendingPermissionRequests,
} from '$lib/chat/transcript/conversation-feed-items.js';
import type { LocalNoticeRow } from '$lib/chat/transcript/local-notice.js';
import type { PendingPermissionRequest } from '$lib/types/chat';

const TS = '2026-05-29T00:00:00.000Z';

function rows(messages: ChatMessage[]) {
	return messages.map((message, index) => ({
		kind: 'message' as const,
		id: `row-${index}`,
		message,
	}));
}

function notice(content: string): LocalNoticeRow {
	return {
		kind: 'local-notice',
		id: `notice-${content}`,
		noticeType: 'warning',
		content,
		timestamp: TS,
	};
}

function questionTool(toolId: string): AskUserQuestionToolUseMessage {
	return new AskUserQuestionToolUseMessage(TS, toolId, undefined, [
		{
			id: 'Which mode?',
			prompt: 'Which mode?',
			header: 'Mode',
			allowMultiple: false,
			options: [
				{ id: 'Fast', label: 'Fast', description: 'Quick path.' },
				{ id: 'Careful', label: 'Careful', description: 'Detailed path.' },
			],
		},
	]);
}

function pendingPermission(
	permissionRequestId: string,
	toolId = permissionRequestId,
): PendingPermissionRequest {
	return {
		permissionRequestId,
		requestedTool: questionTool(toolId),
		chatId: 'chat-1',
		receivedAt: new Date(TS),
	};
}

describe('buildConversationFeedRenderItems', () => {
	it('filters single and grouped command calls when command execution is hidden', () => {
		const items = buildConversationFeedRenderItems(
			rows([
				new UserMessage(TS, 'start'),
				new BashToolUseMessage(TS, 'bash-1', 'pwd'),
				new AssistantMessage(TS, 'between'),
				new BashToolUseMessage(TS, 'bash-2', 'rg foo'),
				new BashToolUseMessage(TS, 'bash-3', 'bun run test'),
			]),
		);

		expect(filterHiddenToolRenderItems(items, ['bash-tool-use']).map((item) => item.kind)).toEqual([
			'message',
			'message',
		]);
		expect(filterHiddenToolRenderItems(items, [])).toBe(items);
	});

	it('filters grouped file reads when file reads are hidden', () => {
		const items = buildConversationFeedRenderItems(
			rows([
				new UserMessage(TS, 'start'),
				new ReadToolUseMessage(TS, 'read-1', '/tmp/a.ts'),
				new ReadToolUseMessage(TS, 'read-2', '/tmp/b.ts'),
				new AssistantMessage(TS, 'done'),
			]),
		);

		expect(filterHiddenToolRenderItems(items, ['read-tool-use']).map((item) => item.kind)).toEqual([
			'message',
			'message',
		]);
	});

	it('groups adjacent bash tool uses into one render item', () => {
		const messages = [
			new UserMessage(TS, 'start'),
			new BashToolUseMessage(TS, 'bash-1', 'pwd'),
			new BashToolUseMessage(TS, 'bash-2', 'rg foo'),
			new AssistantMessage(TS, 'done'),
		];

		const items = buildConversationFeedRenderItems(rows(messages));

		expect(items).toHaveLength(3);
		expect(items[1]).toMatchObject({ kind: 'bash-group' });
		if (items[1].kind !== 'bash-group') throw new Error('expected bash group');
		expect(items[1].messages.map((message) => message.command)).toEqual(['pwd', 'rg foo']);
		expect(items[2]).toMatchObject({ kind: 'message', prevMessage: messages[2] });
	});

	it('keeps a single bash tool use as a normal message', () => {
		const messages = [
			new UserMessage(TS, 'start'),
			new BashToolUseMessage(TS, 'bash-1', 'pwd'),
			new ReadToolUseMessage(TS, 'read-1', '/tmp/file.ts'),
		];

		const items = buildConversationFeedRenderItems(rows(messages));

		expect(items).toHaveLength(3);
		expect(items[1]).toMatchObject({ kind: 'message', message: messages[1] });
	});

	it('groups adjacent read tool uses into one render item', () => {
		const messages = [
			new UserMessage(TS, 'start'),
			new ReadToolUseMessage(TS, 'read-1', '/tmp/a.ts'),
			new ReadToolUseMessage(TS, 'read-2', '/tmp/b.ts'),
			new AssistantMessage(TS, 'done'),
		];

		const items = buildConversationFeedRenderItems(rows(messages));

		expect(items).toHaveLength(3);
		expect(items[1]).toMatchObject({ kind: 'read-group' });
		if (items[1].kind !== 'read-group') throw new Error('expected read group');
		expect(items[1].messages.map((message) => message.filePath)).toEqual([
			'/tmp/a.ts',
			'/tmp/b.ts',
		]);
		expect(items[2]).toMatchObject({ kind: 'message', prevMessage: messages[2] });
	});

	it('keeps a single read tool use as a normal message', () => {
		const messages = [
			new UserMessage(TS, 'start'),
			new ReadToolUseMessage(TS, 'read-1', '/tmp/file.ts'),
			new AssistantMessage(TS, 'done'),
		];

		const items = buildConversationFeedRenderItems(rows(messages));

		expect(items).toHaveLength(3);
		expect(items[1]).toMatchObject({ kind: 'message', message: messages[1] });
	});

	it('groups bash tool uses across hidden tool results', () => {
		const messages = [
			new BashToolUseMessage(TS, 'bash-1', 'pwd'),
			new ToolResultMessage(TS, 'bash-1', { content: 'ok' }, false),
			new BashToolUseMessage(TS, 'bash-2', 'rg foo'),
			new ToolResultMessage(TS, 'bash-2', { content: 'ok' }, false),
		];

		const items = buildConversationFeedRenderItems(rows(messages));

		expect(items).toHaveLength(1);
		expect(items[0]).toMatchObject({ kind: 'bash-group' });
		if (items[0].kind !== 'bash-group') throw new Error('expected bash group');
		expect(items[0].messages.map((message) => message.toolId)).toEqual(['bash-1', 'bash-2']);
	});

	it('groups read tool uses across hidden tool results', () => {
		const messages = [
			new ReadToolUseMessage(TS, 'read-1', '/tmp/a.ts'),
			new ToolResultMessage(TS, 'read-1', { content: 'a' }, false),
			new ReadToolUseMessage(TS, 'read-2', ''),
			new ToolResultMessage(TS, 'read-2', { content: 'b' }, false),
		];

		const model = buildConversationFeedRenderModel(rows(messages));

		expect(model.items).toHaveLength(1);
		expect(model.items[0]).toMatchObject({ kind: 'read-group' });
		if (model.items[0].kind !== 'read-group') throw new Error('expected read group');
		expect(model.items[0].messages.map((message) => message.toolId)).toEqual(['read-1', 'read-2']);
		expect(model.toolResultIndex.get('read-1')?.content).toEqual({ content: 'a' });
		expect(model.toolResultIndex.get('read-2')?.content).toEqual({ content: 'b' });
	});

	it('keeps the group id stable as more adjacent bash tool uses arrive', () => {
		const firstBatch = [
			new BashToolUseMessage(TS, 'bash-1', 'pwd'),
			new BashToolUseMessage(TS, 'bash-2', 'rg foo'),
		];
		const secondBatch = [...firstBatch, new BashToolUseMessage(TS, 'bash-3', 'bun run test')];

		const firstItems = buildConversationFeedRenderItems(rows(firstBatch));
		const secondItems = buildConversationFeedRenderItems(rows(secondBatch));

		expect(firstItems[0]).toMatchObject({ kind: 'bash-group' });
		expect(secondItems[0]).toMatchObject({ kind: 'bash-group' });
		expect(firstItems[0].id).toBe(secondItems[0].id);
	});

	it('keeps the read group id stable as more adjacent read tool uses arrive', () => {
		const firstBatch = [
			new ReadToolUseMessage(TS, 'read-1', '/tmp/a.ts'),
			new ReadToolUseMessage(TS, 'read-2', ''),
		];
		const secondBatch = [...firstBatch, new ReadToolUseMessage(TS, 'read-3', '/tmp/c.ts')];

		const firstItems = buildConversationFeedRenderItems(rows(firstBatch));
		const secondItems = buildConversationFeedRenderItems(rows(secondBatch));

		expect(firstItems[0]).toMatchObject({ kind: 'read-group' });
		expect(secondItems[0]).toMatchObject({ kind: 'read-group' });
		expect(firstItems[0].id).toBe(secondItems[0].id);
	});

	it('builds render items and terminal lookup indexes in one pass', () => {
		const messages = [
			new BashToolUseMessage(TS, 'bash-1', 'pwd'),
			new ToolResultMessage(TS, 'bash-1', { content: 'ok' }, false),
			new PermissionResolvedMessage(TS, 'perm-1', true),
			new PermissionCancelledMessage(TS, 'perm-2', 'cancelled'),
			new AssistantMessage(TS, 'done'),
		];

		const model = buildConversationFeedRenderModel(rows(messages));

		expect(model.items.map((item) => item.kind)).toEqual(['message', 'message']);
		expect(model.toolResultIndex.get('bash-1')?.content).toEqual({ content: 'ok' });
		expect(model.permissionTerminalById.get('perm-1')).toEqual({
			state: 'resolved',
			allowed: true,
		});
		expect(model.permissionTerminalById.get('perm-2')).toEqual({
			state: 'cancelled',
			reason: 'cancelled',
		});
	});

	it('indexes Exec results without rendering them as standalone rows', () => {
		const tool = new ExecToolUseMessage(TS, 'exec-1', 'text("ok")', 'javascript');
		const result = new ToolResultMessage(TS, 'exec-1', { raw: 'ok' }, false);
		const model = buildConversationFeedRenderModel(rows([tool, result]));

		expect(model.items).toHaveLength(1);
		expect(model.items[0]).toMatchObject({ kind: 'message', message: tool });
		expect(model.toolResultIndex.get('exec-1')).toBe(result);
	});

	it('keeps local notices as their own render items and breaks assistant grouping', () => {
		const firstAssistant = new AssistantMessage(TS, 'before');
		const secondAssistant = new AssistantMessage(TS, 'after');
		const localNotice = notice('Chat interrupted by user.');

		const items = buildConversationFeedRenderItems([
			{ kind: 'message', id: 'assistant-1', message: firstAssistant },
			localNotice,
			{ kind: 'message', id: 'assistant-2', message: secondAssistant },
		]);

		expect(items.map((item) => item.kind)).toEqual(['message', 'local-notice', 'message']);
		expect(items[1]).toMatchObject({
			kind: 'local-notice',
			notice: localNotice,
			prevMessage: firstAssistant,
		});
		expect(items[2]).toMatchObject({
			kind: 'message',
			message: secondAssistant,
			prevMessage: null,
		});
	});

	it('derives unique render keys for bash groups with duplicate starting tool IDs', () => {
		const messages = [
			new BashToolUseMessage(TS, 'dup-bash', 'pwd'),
			new BashToolUseMessage(TS, 'bash-2', 'ls'),
			new AssistantMessage(TS, 'separator'),
			new BashToolUseMessage(TS, 'dup-bash', 'git status'),
			new BashToolUseMessage(TS, 'bash-4', 'bun test'),
		];

		const items = buildConversationFeedRenderItems(rows(messages));
		const keys = items.map((item) => item.id);

		expect(items.filter((item) => item.kind === 'bash-group')).toHaveLength(2);
		expect(new Set(keys).size).toBe(keys.length);
	});

	it('derives unique render keys for read groups with duplicate starting tool IDs', () => {
		const messages = [
			new ReadToolUseMessage(TS, 'dup-read', '/tmp/a.ts'),
			new ReadToolUseMessage(TS, 'read-2', '/tmp/b.ts'),
			new AssistantMessage(TS, 'separator'),
			new ReadToolUseMessage(TS, 'dup-read', '/tmp/c.ts'),
			new ReadToolUseMessage(TS, 'read-4', '/tmp/d.ts'),
		];

		const items = buildConversationFeedRenderItems(rows(messages));
		const keys = items.map((item) => item.id);

		expect(items.filter((item) => item.kind === 'read-group')).toHaveLength(2);
		expect(new Set(keys).size).toBe(keys.length);
	});

	it('reconstructs answered AskUserQuestion terminal selections from toolUseResult metadata', () => {
		const terminal = askUserQuestionTerminalFromResult(
			questionTool('tool-question'),
			new ToolResultMessage(
				TS,
				'tool-question',
				{ toolUseResult: { answers: { 'Which mode?': 'Careful' } } },
				false,
			),
		);

		expect(terminal).toEqual({
			state: 'resolved',
			allowed: true,
			selectedQuestionOptions: { 'Which mode?': ['Careful'] },
		});
	});

	it('reconstructs skipped AskUserQuestion terminal state from empty answers', () => {
		const terminal = askUserQuestionTerminalFromResult(
			questionTool('tool-question'),
			new ToolResultMessage(
				TS,
				'tool-question',
				{
					raw: 'The user did not answer the questions.',
					toolUseResult: { answers: {} },
				},
				false,
			),
		);

		expect(terminal).toEqual({
			state: 'resolved',
			allowed: false,
			reason: 'The user did not answer the questions.',
		});
	});

	it('skips standalone AskUserQuestion tools when an explicit permission request row exists', () => {
		const standalone = questionTool('tool-question');
		const explicit = new PermissionRequestMessage(
			TS,
			askUserQuestionPermissionId('tool-question'),
			questionTool('tool-question'),
		);

		const model = buildConversationFeedRenderModel(rows([standalone, explicit]));

		expect(model.items).toHaveLength(1);
		expect(model.items[0]).toMatchObject({ kind: 'message', message: explicit });
	});
});

describe('visiblePendingPermissionRequests', () => {
	it('returns pending requests that do not already have a visible transcript row', () => {
		const pending = [pendingPermission('perm-1'), pendingPermission('perm-2')];
		const visibleRows = rows([
			new AssistantMessage(TS, 'before'),
			new PermissionRequestMessage(TS, 'perm-1', questionTool('tool-1')),
		]);

		expect(visiblePendingPermissionRequests(visibleRows, pending)).toEqual([pending[1]]);
	});

	it('omits pending requests that already have visible terminal state', () => {
		const pending = [pendingPermission('perm-1'), pendingPermission('perm-2')];
		const visibleRows = rows([
			new PermissionResolvedMessage(TS, 'perm-1', true),
			new PermissionCancelledMessage(TS, 'perm-2', 'cancelled'),
		]);

		expect(visiblePendingPermissionRequests(visibleRows, pending)).toEqual([]);
	});
});
