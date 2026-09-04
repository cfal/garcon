import { describe, expect, it } from 'vitest';
import {
	AssistantMessage,
	AskUserQuestionToolUseMessage,
	BashToolUseMessage,
	ExecToolUseMessage,
	ExitPlanModeToolUseMessage,
	GlobToolUseMessage,
	PermissionCancelledMessage,
	PermissionExpiredMessage,
	PermissionRequestMessage,
	PermissionResolvedMessage,
	ReadToolUseMessage,
	ToolResultMessage,
	UserMessage,
	WriteStdinToolUseMessage,
	type ChatMessage,
} from '$shared/chat-types';
import { compileHiddenBashCommandPatterns } from '$lib/chat/transcript/hidden-bash-commands.js';
import {
	buildConversationFeedRenderItems,
	buildConversationFeedRenderModel,
	conversationFeedItemLayout,
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
		ordinal: index + 1,
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
	permissionOccurrenceId: string,
	toolId = permissionOccurrenceId,
): PendingPermissionRequest {
	return {
		permissionOccurrenceId,
		requestedTool: questionTool(toolId),
		chatId: 'chat-1',
		receivedAt: new Date(TS),
	};
}

describe('buildConversationFeedRenderItems', () => {
	it('[TLV5-UX.08-WEB-UNIT-01] keeps every renderable transcript message in exact source order', () => {
		const messages = [
			new UserMessage(TS, 'start'),
			new BashToolUseMessage(TS, 'bash-1', 'pwd'),
			new ToolResultMessage(TS, 'bash-1', { content: '/tmp' }, false),
			new BashToolUseMessage(TS, 'bash-2', 'rg foo'),
			new ReadToolUseMessage(TS, 'read-1', '/tmp/a.ts'),
			new ReadToolUseMessage(TS, 'read-2', '/tmp/b.ts'),
			new AssistantMessage(TS, 'done'),
		];

		const model = buildConversationFeedRenderModel(rows(messages));

		expect(model.items.map((item) => item.id)).toEqual([
			'row-0',
			'row-1',
			'row-2',
			'row-3',
			'row-4',
			'row-5',
			'row-6',
		]);
		expect(
			model.items.flatMap((item) => (item.kind === 'message' ? [item.message.type] : [])),
		).toEqual([
			'user-message',
			'bash-tool-use',
			'tool-result',
			'bash-tool-use',
			'read-tool-use',
			'read-tool-use',
			'assistant-message',
		]);
		expect(model.items.map((item) => item.index)).toEqual([0, 1, 2, 3, 4, 5, 6]);
		expect(model.toolResultByUseRowId.get('row-1')).toBe(messages[2]);
		expect(model.toolResultRowIdByUseRowId.get('row-1')).toBe('row-2');
		expect(model.items[2]).toMatchObject({ pairedToolUse: messages[1] });
	});

	it('filters each hidden tool row without changing the remaining order', () => {
		const model = buildConversationFeedRenderModel(
			rows([
				new UserMessage(TS, 'start'),
				new BashToolUseMessage(TS, 'bash-1', 'pwd'),
				new ToolResultMessage(TS, 'bash-1', { raw: '/tmp' }, false),
				new ExecToolUseMessage(TS, 'exec-1', 'text("ok")', 'javascript'),
				new ToolResultMessage(TS, 'exec-1', { raw: 'ok' }, false),
				new BashToolUseMessage(TS, 'bash-2', 'rg foo'),
				new AssistantMessage(TS, 'done'),
			]),
		);

		const visibleTypes = (hiddenToolTypes: readonly string[]) =>
			filterHiddenToolRenderItems(model.items, hiddenToolTypes).flatMap((item) =>
				item.kind === 'message' ? [item.message.type] : [],
			);

		expect(visibleTypes(['bash-tool-use'])).toEqual([
			'user-message',
			'exec-tool-use',
			'tool-result',
			'assistant-message',
		]);
		expect(visibleTypes(['exec-tool-use'])).toEqual([
			'user-message',
			'bash-tool-use',
			'tool-result',
			'bash-tool-use',
			'assistant-message',
		]);
		expect(filterHiddenToolRenderItems(model.items, [])).toBe(model.items);
	});

	it('hides bash rows matching a command pattern together with their paired result', () => {
		const model = buildConversationFeedRenderModel(
			rows([
				new UserMessage(TS, 'start'),
				new BashToolUseMessage(TS, 'bash-1', 'git status'),
				new ToolResultMessage(TS, 'bash-1', { raw: 'clean' }, false),
				new BashToolUseMessage(TS, 'bash-2', 'rg foo'),
				new ToolResultMessage(TS, 'bash-2', { raw: 'bar' }, false),
				new AssistantMessage(TS, 'done'),
			]),
		);
		const hiddenBashCommands = compileHiddenBashCommandPatterns([
			{ pattern: 'git *', mode: 'glob' },
		]);
		if (!hiddenBashCommands) throw new Error('expected compiled bash command matcher');

		const visible = filterHiddenToolRenderItems(model.items, [], hiddenBashCommands);

		expect(visible.flatMap((item) => (item.kind === 'message' ? [item.message.type] : []))).toEqual(
			['user-message', 'bash-tool-use', 'tool-result', 'assistant-message'],
		);
		expect(filterHiddenToolRenderItems(model.items, [], null)).toBe(model.items);
	});

	it('keeps permission requests and write-stdin rows visible when a bash pattern matches', () => {
		const requestedBash = new BashToolUseMessage(TS, 'bash-1', 'git status');
		const model = buildConversationFeedRenderModel(
			rows([
				new PermissionRequestMessage(TS, 'permission-1', requestedBash),
				new WriteStdinToolUseMessage(TS, 'stdin-1', { chars: 'continue' }),
			]),
		);
		const hiddenBashCommands = compileHiddenBashCommandPatterns([
			{ pattern: 'git *', mode: 'glob' },
		]);
		if (!hiddenBashCommands) throw new Error('expected compiled bash command matcher');

		const visible = filterHiddenToolRenderItems(model.items, [], hiddenBashCommands);

		expect(visible.flatMap((item) => (item.kind === 'message' ? [item.message.type] : []))).toEqual(
			['permission-request', 'write-stdin-tool-use'],
		);
	});

	it('leaves an unpaired result for the layout stage to hide without guessing its tool type', () => {
		const model = buildConversationFeedRenderModel(
			rows([new ToolResultMessage(TS, 'outside-window', { raw: 'result' }, false)]),
		);
		const hiddenBashCommands = compileHiddenBashCommandPatterns([
			{ pattern: 'git *', mode: 'glob' },
		]);
		if (!hiddenBashCommands) throw new Error('expected compiled bash command matcher');

		const filtered = filterHiddenToolRenderItems(model.items, [], hiddenBashCommands);

		expect(filtered).toHaveLength(1);
		expect(conversationFeedItemLayout(filtered[0])).toBe('hidden');
	});

	it('assigns layout only to rows with visible standalone presentation', () => {
		const model = buildConversationFeedRenderModel(
			rows([
				new BashToolUseMessage(TS, 'bash-1', 'pwd'),
				new ToolResultMessage(TS, 'bash-1', { raw: '/tmp' }, false),
				new GlobToolUseMessage(TS, 'glob-1', '**/*.ts'),
				new ToolResultMessage(TS, 'glob-1', { filenames: ['a.ts'] }, false),
				questionTool('question-1'),
				new ToolResultMessage(
					TS,
					'question-1',
					{ toolUseResult: { answers: { 'Which mode?': 'Careful' } } },
					false,
				),
				new PermissionResolvedMessage(TS, 'incarnation-1', true),
			]),
		);

		expect(model.items.map(conversationFeedItemLayout)).toEqual([
			'standard',
			'hidden',
			'standard',
			'standard',
			'hidden',
			'permission',
			'hidden',
		]);
	});

	it('uses transcript row identity even when providers repeat tool ids', () => {
		const items = buildConversationFeedRenderItems(
			rows([
				new BashToolUseMessage(TS, 'duplicate-tool', 'pwd'),
				new BashToolUseMessage(TS, 'duplicate-tool', 'ls'),
				new ReadToolUseMessage(TS, 'duplicate-tool', '/tmp/a.ts'),
				new ReadToolUseMessage(TS, 'duplicate-tool', '/tmp/b.ts'),
			]),
		);

		expect(items.map((item) => item.id)).toEqual(['row-0', 'row-1', 'row-2', 'row-3']);
		expect(new Set(items.map((item) => item.id)).size).toBe(items.length);
	});

	it('keeps paired results and permission terminals as standalone rows', () => {
		const tool = new ExecToolUseMessage(TS, 'exec-1', 'text("ok")', 'javascript');
		const result = new ToolResultMessage(TS, 'exec-1', { raw: 'ok' }, false);
		const model = buildConversationFeedRenderModel(
			rows([
				tool,
				result,
				new PermissionResolvedMessage(TS, 'incarnation-1', true),
				new PermissionCancelledMessage(TS, 'incarnation-2', 'cancelled'),
				new PermissionExpiredMessage(TS, 'incarnation-3'),
				new AssistantMessage(TS, 'done'),
			]),
		);

		expect(model.items.map((item) => item.id)).toEqual([
			'row-0',
			'row-1',
			'row-2',
			'row-3',
			'row-4',
			'row-5',
		]);
		expect(model.toolResultByUseRowId.get('row-0')).toBe(result);
		expect(model.items[1]).toMatchObject({ pairedToolUse: tool });
		expect(conversationFeedItemLayout(model.items[4])).toBe('hidden');
		expect(model.permissionTerminalByOccurrence.get('incarnation-1')).toEqual({
			permissionOccurrenceId: 'incarnation-1',
			state: 'resolved',
			allowed: true,
		});
		expect(model.permissionTerminalByOccurrence.get('incarnation-2')).toEqual({
			permissionOccurrenceId: 'incarnation-2',
			state: 'cancelled',
			reason: 'cancelled',
		});
		expect(model.permissionTerminalByOccurrence.get('incarnation-3')).toEqual({
			permissionOccurrenceId: 'incarnation-3',
			state: 'cancelled',
			reason: 'expired',
		});
	});

	it('[TLV5-PERM.08-WEB-UNIT-01] keeps terminal state separate across permission occurrences', () => {
		const first = new PermissionCancelledMessage(TS, 'first-occurrence', 'cancelled');
		const second = new PermissionResolvedMessage(TS, 'second-occurrence', true);
		const model = buildConversationFeedRenderModel(rows([first, second]));

		expect(model.permissionTerminalByOccurrence.size).toBe(2);
		expect([...model.permissionTerminalByOccurrence.values()].map((terminal) => (
			terminal.permissionOccurrenceId
		))).toEqual(['first-occurrence', 'second-occurrence']);
	});

	it('pairs interleaved results to individual tool rows in source order', () => {
		const first = new GlobToolUseMessage(TS, 'glob-1', 'src/**/*.ts');
		const second = new GlobToolUseMessage(TS, 'glob-2', 'test/**/*.ts');
		const firstResult = new ToolResultMessage(
			TS,
			'glob-1',
			{ filenames: ['src/a.ts'], numFiles: 1 },
			false,
		);
		const secondResult = new ToolResultMessage(
			TS,
			'glob-2',
			{ filenames: ['test/a.ts'], numFiles: 1 },
			false,
		);
		const model = buildConversationFeedRenderModel(
			rows([first, second, firstResult, secondResult, new AssistantMessage(TS, 'done')]),
		);

		expect(model.items.map((item) => item.id)).toEqual([
			'row-0',
			'row-1',
			'row-2',
			'row-3',
			'row-4',
		]);
		expect(model.toolResultByUseRowId.get('row-0')).toBe(firstResult);
		expect(model.toolResultByUseRowId.get('row-1')).toBe(secondResult);
		expect(model.toolResultRowIdByUseRowId.get('row-0')).toBe('row-2');
		expect(model.toolResultRowIdByUseRowId.get('row-1')).toBe('row-3');
		expect(model.items[2]).toMatchObject({ pairedToolUse: first });
		expect(model.items[3]).toMatchObject({ pairedToolUse: second });
	});

	it('pairs repeated provider tool ids by exact FIFO occurrence', () => {
		const first = new BashToolUseMessage(TS, 'reused-tool', 'printf first');
		const firstResult = new ToolResultMessage(TS, 'reused-tool', { raw: 'first' }, false);
		const second = new BashToolUseMessage(TS, 'reused-tool', 'printf second');
		const secondResult = new ToolResultMessage(TS, 'reused-tool', { raw: 'second' }, false);
		const model = buildConversationFeedRenderModel(
			rows([first, firstResult, second, secondResult]),
		);

		expect(model.items.map((item) => item.id)).toEqual(['row-0', 'row-1', 'row-2', 'row-3']);
		expect(model.toolResultByUseRowId.get('row-0')).toBe(firstResult);
		expect(model.toolResultByUseRowId.get('row-2')).toBe(secondResult);
		expect(model.toolResultRowIdByUseRowId.get('row-0')).toBe('row-1');
		expect(model.toolResultRowIdByUseRowId.get('row-2')).toBe('row-3');
	});

	it('keeps a suffix result row mounted when its use arrives from an earlier page', () => {
		const tool = new GlobToolUseMessage(TS, 'glob-1', 'src/**/*.ts');
		const result = new ToolResultMessage(
			TS,
			'glob-1',
			{ filenames: ['src/a.ts'], numFiles: 1 },
			false,
		);
		const assistant = new AssistantMessage(TS, 'done');
		const resultRow = { kind: 'message' as const, id: 'row-2', ordinal: 2, message: result };
		const assistantRow = { kind: 'message' as const, id: 'row-3', ordinal: 3, message: assistant };

		const suffix = buildConversationFeedRenderModel([resultRow, assistantRow]);
		const prepended = buildConversationFeedRenderModel([
			{ kind: 'message', id: 'row-1', ordinal: 1, message: tool },
			resultRow,
			assistantRow,
		]);

		expect(suffix.items.map((item) => item.id)).toEqual(['row-2', 'row-3']);
		expect(prepended.items.map((item) => item.id)).toEqual(['row-1', 'row-2', 'row-3']);
		expect(prepended.toolResultByUseRowId.get('row-1')).toBe(result);
		expect(prepended.items[1]).toMatchObject({ pairedToolUse: tool });
	});

	it('keeps local notices as individual rows', () => {
		const localNotice = notice('Chat interrupted by user.');
		const items = buildConversationFeedRenderItems([
			{ kind: 'message', id: 'assistant-1', message: new AssistantMessage(TS, 'before') },
			localNotice,
			{ kind: 'message', id: 'assistant-2', message: new AssistantMessage(TS, 'after') },
		]);

		expect(items.map((item) => [item.kind, item.id])).toEqual([
			['message', 'assistant-1'],
			['local-notice', localNotice.id],
			['message', 'assistant-2'],
		]);
	});

	it('keeps an AskUserQuestion tool and its permission wrapper as separate rows', () => {
		const standalone = questionTool('tool-question');
		const explicit = new PermissionRequestMessage(
			TS,
			'incarnation-1',
			questionTool('tool-question'),
		);

		const model = buildConversationFeedRenderModel(rows([standalone, explicit]));

		expect(model.items.map((item) => item.id)).toEqual(['row-0', 'row-1']);
		expect(model.items[1]).toMatchObject({ kind: 'message', message: explicit });
	});

	it('keeps repeated AskUserQuestion tool ids as distinct canonical rows', () => {
		const firstStandalone = questionTool('reused-question');
		const secondStandalone = questionTool('reused-question');
		const firstWrapper = new PermissionRequestMessage(
			TS,
			'incarnation-1',
			questionTool('reused-question'),
		);
		const secondWrapper = new PermissionRequestMessage(
			TS,
			'incarnation-2',
			questionTool('reused-question'),
		);
		const laterStandalone = questionTool('reused-question');

		const model = buildConversationFeedRenderModel(
			rows([firstStandalone, secondStandalone, firstWrapper, secondWrapper, laterStandalone]),
		);

		expect(model.items.map((item) => item.id)).toEqual([
			'row-0',
			'row-1',
			'row-2',
			'row-3',
			'row-4',
		]);
	});

	it('keeps a permission wrapper that precedes repeated standalone tools in source order', () => {
		const wrapper = new PermissionRequestMessage(
			TS,
			'incarnation-1',
			questionTool('reused-question'),
		);

		const model = buildConversationFeedRenderModel(
			rows([wrapper, questionTool('reused-question'), questionTool('reused-question')]),
		);

		expect(model.items.map((item) => item.id)).toEqual(['row-0', 'row-1', 'row-2']);
	});

	it('suppresses only the answered question result represented by the matching wrapper occurrence', () => {
		const firstWrapper = new PermissionRequestMessage(
			TS,
			'incarnation-1',
			questionTool('reused-question'),
		);
		const firstResult = new ToolResultMessage(
			TS,
			'reused-question',
			{ toolUseResult: { answers: { 'Which mode?': 'Careful' } } },
			false,
		);
		const secondResult = new ToolResultMessage(
			TS,
			'reused-question',
			{ toolUseResult: { answers: { 'Which mode?': 'Fast' } } },
			false,
		);
		const model = buildConversationFeedRenderModel(
			rows([
				firstWrapper,
				questionTool('reused-question'),
				firstResult,
				questionTool('reused-question'),
				secondResult,
			]),
		);

		expect(model.items.map((item) => item.id)).toEqual([
			'row-0',
			'row-1',
			'row-2',
			'row-3',
			'row-4',
		]);
		expect(model.items.map(conversationFeedItemLayout)).toEqual([
			'permission',
			'hidden',
			'hidden',
			'hidden',
			'permission',
		]);
	});
});

describe('visiblePendingPermissionRequests', () => {
	it('returns pending requests without a visible transcript row', () => {
		const pending = [pendingPermission('perm-1'), pendingPermission('perm-2')];
		const visibleRows = rows([
			new AssistantMessage(TS, 'before'),
			new PermissionRequestMessage(TS, 'perm-1', questionTool('tool-1')),
		]);

		expect(visiblePendingPermissionRequests(visibleRows, pending)).toEqual([pending[1]]);
	});

	it('does not float an exit-plan request already represented by its canonical tool row', () => {
		const exitPlan = new ExitPlanModeToolUseMessage(TS, 'plan-1', 'Implement carefully.');
		const pending: PendingPermissionRequest = {
			permissionOccurrenceId: 'plan-exit-plan-1',
			requestedTool: exitPlan,
			chatId: 'chat-1',
			receivedAt: new Date(TS),
		};

		expect(visiblePendingPermissionRequests(rows([exitPlan]), [pending])).toEqual([]);
	});

	it('does not hide a reused exit-plan request behind an older occurrence', () => {
		const historical = new ExitPlanModeToolUseMessage(TS, 'plan-1', 'Historical plan.');
		const current: PendingPermissionRequest = {
			permissionOccurrenceId: 'current-occurrence',
			requestedTool: new ExitPlanModeToolUseMessage(TS, 'plan-1', 'Current plan.'),
			chatId: 'chat-1',
			receivedAt: new Date(TS),
		};

		expect(visiblePendingPermissionRequests(rows([historical]), [current])).toEqual([current]);
	});

	it('omits terminal and replayed pending permission ids', () => {
		const first = pendingPermission('perm-1');
		const replay = pendingPermission('perm-1');
		const second = pendingPermission('perm-2');
		const visibleRows = rows([
			new PermissionResolvedMessage(TS, 'perm-2', true),
		]);

		expect(visiblePendingPermissionRequests(visibleRows, [first, replay, second])).toEqual([first]);
	});

	it('does not let an old terminal suppress a distinct permission occurrence', () => {
		const terminal = new PermissionCancelledMessage(TS, 'old-occurrence', 'cancelled');
		const current = {
			...pendingPermission('current-occurrence'),
			control: {
				serverInstanceId: 'server-1',
				chatId: 'chat-1',
				runId: 'run-2',
				permissionOccurrenceId: 'current-occurrence',
			},
		};

		expect(visiblePendingPermissionRequests(rows([terminal]), [current])).toEqual([current]);
	});
});
