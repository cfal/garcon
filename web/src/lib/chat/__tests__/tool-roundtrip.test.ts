import { describe, it, expect } from 'vitest';
import {
	BashToolUseMessage,
	ReadToolUseMessage,
	ListToolUseMessage,
	EditToolUseMessage,
	WriteToolUseMessage,
	ApplyPatchToolUseMessage,
	GrepToolUseMessage,
	GlobToolUseMessage,
	WebSearchToolUseMessage,
	WebFetchToolUseMessage,
		TodoWriteToolUseMessage,
		TodoReadToolUseMessage,
		TaskToolUseMessage,
		CodexSubagentToolUseMessage,
		UpdatePlanToolUseMessage,
	WriteStdinToolUseMessage,
	EnterPlanModeToolUseMessage,
	ExitPlanModeToolUseMessage,
	CursorAskQuestionToolUseMessage,
	CursorCreatePlanToolUseMessage,
	AmpFinderToolUseMessage,
	AmpOracleToolUseMessage,
	AmpLibrarianToolUseMessage,
	AmpSkillToolUseMessage,
	AmpMermaidToolUseMessage,
	AmpHandoffToolUseMessage,
	AmpLookAtToolUseMessage,
	AmpFindThreadToolUseMessage,
	AmpReadThreadToolUseMessage,
	AmpTaskListToolUseMessage,
	ExternalToolUseMessage,
	McpToolUseMessage,
	RequestPermissionsToolUseMessage,
	UnknownToolUseMessage,
	PermissionRequestMessage,
	UserMessage,
	parseChatMessage,
} from '$shared/chat-types';

const TS = '2026-03-01T00:00:00.000Z';

// Serializes a message via JSON.stringify and parses it back through
// parseChatMessage, verifying the round-trip produces the same subclass
// with equivalent fields.
function roundTrip<T>(message: T): T {
	const json = JSON.parse(JSON.stringify(message));
	const parsed = parseChatMessage(json);
	expect(parsed).not.toBeNull();
	expect(parsed!.constructor.name).toBe((message as object).constructor.name);
	return parsed as T;
}

describe('tool-use serialization round-trip', () => {
	it('BashToolUseMessage preserves command and description', () => {
		const msg = new BashToolUseMessage(TS, 'id-1', 'ls -la', 'List files');
		const parsed = roundTrip(msg);
		expect(parsed.command).toBe('ls -la');
		expect(parsed.description).toBe('List files');
		expect(parsed.type).toBe('bash-tool-use');
	});

	it('ReadToolUseMessage preserves filePath and range fields', () => {
		const msg = new ReadToolUseMessage(TS, 'id-2', '/tmp/test.ts', 10, 50, 60);
		const parsed = roundTrip(msg);
		expect(parsed.filePath).toBe('/tmp/test.ts');
		expect(parsed.offset).toBe(10);
		expect(parsed.limit).toBe(50);
		expect(parsed.endLine).toBe(60);
	});

	it('ListToolUseMessage preserves directory path', () => {
		const msg = new ListToolUseMessage(TS, 'id-2b', '/tmp');
		const parsed = roundTrip(msg);
		expect(parsed.path).toBe('/tmp');
		expect(parsed.type).toBe('list-tool-use');
	});

	it('EditToolUseMessage preserves diff fields', () => {
		const msg = new EditToolUseMessage(TS, 'id-3', '/tmp/a.ts', 'old', 'new');
		const parsed = roundTrip(msg);
		expect(parsed.filePath).toBe('/tmp/a.ts');
		expect(parsed.oldString).toBe('old');
		expect(parsed.newString).toBe('new');
	});

	it('EditToolUseMessage preserves changes array', () => {
		const changes = [{ path: '/tmp/b.ts', kind: 'update' }];
		const msg = new EditToolUseMessage(TS, 'id-4', undefined, undefined, undefined, changes);
		const parsed = roundTrip(msg);
		expect(parsed.changes).toEqual(changes);
	});

	it('WriteToolUseMessage preserves filePath and content', () => {
		const msg = new WriteToolUseMessage(TS, 'id-5', '/tmp/out.ts', 'file content');
		const parsed = roundTrip(msg);
		expect(parsed.filePath).toBe('/tmp/out.ts');
		expect(parsed.content).toBe('file content');
	});

	it('ApplyPatchToolUseMessage preserves diff fields', () => {
		const msg = new ApplyPatchToolUseMessage(
			TS,
			'id-6',
			'/tmp/p.ts',
			'before',
			'after',
			'patch text',
		);
		const parsed = roundTrip(msg);
		expect(parsed.filePath).toBe('/tmp/p.ts');
		expect(parsed.oldString).toBe('before');
		expect(parsed.newString).toBe('after');
		expect(parsed.patch).toBe('patch text');
	});

	it('GrepToolUseMessage preserves pattern and path', () => {
		const msg = new GrepToolUseMessage(TS, 'id-7', 'TODO', '/src');
		const parsed = roundTrip(msg);
		expect(parsed.pattern).toBe('TODO');
		expect(parsed.path).toBe('/src');
	});

	it('GlobToolUseMessage preserves pattern and path', () => {
		const msg = new GlobToolUseMessage(TS, 'id-8', '**/*.ts', '/src');
		const parsed = roundTrip(msg);
		expect(parsed.pattern).toBe('**/*.ts');
		expect(parsed.path).toBe('/src');
	});

	it('WebSearchToolUseMessage preserves query', () => {
		const msg = new WebSearchToolUseMessage(TS, 'id-9', 'svelte 5 runes');
		const parsed = roundTrip(msg);
		expect(parsed.query).toBe('svelte 5 runes');
	});

	it('WebFetchToolUseMessage preserves url and prompt', () => {
		const msg = new WebFetchToolUseMessage(TS, 'id-10', 'https://example.com', 'summarize');
		const parsed = roundTrip(msg);
		expect(parsed.url).toBe('https://example.com');
		expect(parsed.prompt).toBe('summarize');
	});

	it('TodoWriteToolUseMessage preserves todos', () => {
		const todos = [{ content: 'task 1', status: 'pending' as const }];
		const msg = new TodoWriteToolUseMessage(TS, 'id-11', todos);
		const parsed = roundTrip(msg);
		expect(parsed.todos).toEqual(todos);
	});

	it('TodoReadToolUseMessage round-trips', () => {
		const msg = new TodoReadToolUseMessage(TS, 'id-12');
		const parsed = roundTrip(msg);
		expect(parsed.type).toBe('todo-read-tool-use');
	});

	it('TaskToolUseMessage preserves all fields', () => {
		const msg = new TaskToolUseMessage(
			TS,
			'id-13',
			'Explore',
			'Find files',
			'search for X',
			'sonnet',
		);
		const parsed = roundTrip(msg);
		expect(parsed.subagentType).toBe('Explore');
		expect(parsed.description).toBe('Find files');
		expect(parsed.prompt).toBe('search for X');
		expect(parsed.model).toBe('sonnet');
	});

	it('CodexSubagentToolUseMessage preserves action and details', () => {
		const msg = new CodexSubagentToolUseMessage(TS, 'id-codex-subagent', 'spawn_agent', {
			taskName: 'review-auth',
			message: 'Review auth boundaries',
			model: 'gpt-5.5',
			forkTurns: 'all',
		});
		const parsed = roundTrip(msg);
		expect(parsed).toBeInstanceOf(CodexSubagentToolUseMessage);
		expect(parsed.action).toBe('spawn_agent');
		expect(parsed.details).toEqual({
			taskName: 'review-auth',
			message: 'Review auth boundaries',
			model: 'gpt-5.5',
			forkTurns: 'all',
		});
	});

	it('UpdatePlanToolUseMessage preserves todos', () => {
		const msg = new UpdatePlanToolUseMessage(TS, 'id-14', [
			{ content: 'step 1', status: 'pending' as const },
		]);
		const parsed = roundTrip(msg);
		expect(parsed.todos).toEqual([{ content: 'step 1', status: 'pending' }]);
	});

	it('WriteStdinToolUseMessage preserves input record', () => {
		const msg = new WriteStdinToolUseMessage(TS, 'id-15', { session_id: 42 });
		const parsed = roundTrip(msg);
		expect(parsed.type).toBe('write-stdin-tool-use');
	});

	it('EnterPlanModeToolUseMessage round-trips', () => {
		const msg = new EnterPlanModeToolUseMessage(TS, 'id-16');
		const parsed = roundTrip(msg);
		expect(parsed.type).toBe('enter-plan-mode-tool-use');
	});

	it('ExitPlanModeToolUseMessage preserves plan and allowedPrompts', () => {
		const prompts = [{ tool: 'Bash', prompt: 'run tests' }];
		const msg = new ExitPlanModeToolUseMessage(TS, 'id-17', 'The plan text', prompts);
		const parsed = roundTrip(msg);
		expect(parsed.plan).toBe('The plan text');
		expect(parsed.allowedPrompts).toEqual(prompts);
	});

	it('CursorAskQuestionToolUseMessage preserves questions', () => {
		const msg = new CursorAskQuestionToolUseMessage(TS, 'id-cursor-question', 'Need input', [
			{
				id: 'q1',
				prompt: 'Which mode?',
				options: [{ id: 'agent', label: 'Agent' }],
				allowMultiple: false,
			},
		]);
		const parsed = roundTrip(msg);
		expect(parsed).toBeInstanceOf(CursorAskQuestionToolUseMessage);
		expect(parsed.questions).toEqual([
			{
				id: 'q1',
				prompt: 'Which mode?',
				options: [{ id: 'agent', label: 'Agent' }],
				allowMultiple: false,
			},
		]);
	});

	it('CursorCreatePlanToolUseMessage preserves plan metadata', () => {
		const msg = new CursorCreatePlanToolUseMessage(
			TS,
			'id-cursor-plan',
			'Do the work',
			'Refactor',
			'Tighten implementation',
			[{ id: 'todo-1', content: 'Inspect', status: 'completed' }],
			false,
			[{ name: 'Phase 1', todos: [{ content: 'Patch', status: 'in_progress' }] }],
		);
		const parsed = roundTrip(msg);
		expect(parsed).toBeInstanceOf(CursorCreatePlanToolUseMessage);
		expect(parsed.plan).toBe('Do the work');
		expect(parsed.todos).toEqual([{ id: 'todo-1', content: 'Inspect', status: 'completed' }]);
		expect(parsed.phases).toEqual([
			{ name: 'Phase 1', todos: [{ content: 'Patch', status: 'in_progress' }] },
		]);
	});

	it('AmpFinderToolUseMessage preserves query', () => {
		const msg = new AmpFinderToolUseMessage(TS, 'id-amp-1', 'find auth handlers');
		const parsed = roundTrip(msg);
		expect(parsed.query).toBe('find auth handlers');
	});

	it('AmpOracleToolUseMessage preserves structured fields', () => {
		const msg = new AmpOracleToolUseMessage(
			TS,
			'id-amp-2',
			'Review auth',
			'Focus on websocket flow',
			['src/auth.ts'],
		);
		const parsed = roundTrip(msg);
		expect(parsed.task).toBe('Review auth');
		expect(parsed.context).toBe('Focus on websocket flow');
		expect(parsed.files).toEqual(['src/auth.ts']);
	});

	it('AmpLibrarianToolUseMessage preserves query and context', () => {
		const msg = new AmpLibrarianToolUseMessage(TS, 'id-amp-3', 'Find docs', 'auth subsystem');
		const parsed = roundTrip(msg);
		expect(parsed.query).toBe('Find docs');
		expect(parsed.context).toBe('auth subsystem');
	});

	it('AmpSkillToolUseMessage preserves name', () => {
		const msg = new AmpSkillToolUseMessage(TS, 'id-amp-4', 'lsp');
		const parsed = roundTrip(msg);
		expect(parsed.name).toBe('lsp');
	});

	it('AmpMermaidToolUseMessage round-trips', () => {
		const msg = new AmpMermaidToolUseMessage(TS, 'id-amp-5');
		const parsed = roundTrip(msg);
		expect(parsed.type).toBe('amp-mermaid-tool-use');
	});

	it('AmpHandoffToolUseMessage preserves goal', () => {
		const msg = new AmpHandoffToolUseMessage(TS, 'id-amp-6', 'Continue the implementation');
		const parsed = roundTrip(msg);
		expect(parsed.goal).toBe('Continue the implementation');
	});

	it('AmpLookAtToolUseMessage preserves path and objective', () => {
		const msg = new AmpLookAtToolUseMessage(TS, 'id-amp-7', '/tmp/app.css', 'Review theme tokens');
		const parsed = roundTrip(msg);
		expect(parsed.path).toBe('/tmp/app.css');
		expect(parsed.objective).toBe('Review theme tokens');
	});

	it('AmpFindThreadToolUseMessage preserves query', () => {
		const msg = new AmpFindThreadToolUseMessage(TS, 'id-amp-8', 'auth race condition');
		const parsed = roundTrip(msg);
		expect(parsed.query).toBe('auth race condition');
	});

	it('AmpReadThreadToolUseMessage preserves threadId and goal', () => {
		const msg = new AmpReadThreadToolUseMessage(
			TS,
			'id-amp-9',
			'thread-123',
			'Summarize decisions',
		);
		const parsed = roundTrip(msg);
		expect(parsed.threadId).toBe('thread-123');
		expect(parsed.goal).toBe('Summarize decisions');
	});

	it('AmpTaskListToolUseMessage preserves task metadata', () => {
		const msg = new AmpTaskListToolUseMessage(
			TS,
			'id-amp-10',
			'update',
			'42',
			'Ship implementation',
			'done',
		);
		const parsed = roundTrip(msg);
		expect(parsed.action).toBe('update');
		expect(parsed.taskId).toBe('42');
		expect(parsed.title).toBe('Ship implementation');
		expect(parsed.status).toBe('done');
	});

	it('ExternalToolUseMessage preserves tool metadata', () => {
		const msg = new ExternalToolUseMessage(TS, 'id-external-1', 'search', { q: 'threads' }, 'app');
		const parsed = roundTrip(msg);
		expect(parsed.name).toBe('search');
		expect(parsed.namespace).toBe('app');
		expect(parsed.input).toEqual({ q: 'threads' });
	});

	it('McpToolUseMessage preserves server and tool metadata', () => {
		const msg = new McpToolUseMessage(TS, 'id-mcp-1', 'github', 'list_prs', { state: 'open' });
		const parsed = roundTrip(msg);
		expect(parsed.server).toBe('github');
		expect(parsed.tool).toBe('list_prs');
		expect(parsed.input).toEqual({ state: 'open' });
	});

	it('RequestPermissionsToolUseMessage preserves requested permissions', () => {
		const msg = new RequestPermissionsToolUseMessage(
			TS,
			'id-permissions-1',
			{ network: { enabled: true } },
			'Need API access',
		);
		const parsed = roundTrip(msg);
		expect(parsed.permissions).toEqual({ network: { enabled: true } });
		expect(parsed.reason).toBe('Need API access');
	});

	it('UnknownToolUseMessage preserves rawName and input without metadata', () => {
		const msg = new UnknownToolUseMessage(TS, 'id-18', 'custom_tool', { key: 'val' });
		const parsed = roundTrip(msg);
		expect(parsed.rawName).toBe('custom_tool');
		expect(parsed.input).toEqual({ key: 'val' });
	});
});

describe('wire format parsing', () => {
		it('preserves user-message metadata for command reconciliation', () => {
			const msg = new UserMessage(TS, 'hello', undefined, {
				clientRequestId: 'req-1',
				upstreamRequestId: 'cursor-req-1',
				turnId: 'turn-1',
			deliveryStatus: 'submitting',
		});
		const parsed = roundTrip(msg);

			expect(parsed.metadata).toEqual({
				clientRequestId: 'req-1',
				upstreamRequestId: 'cursor-req-1',
				turnId: 'turn-1',
			deliveryStatus: 'submitting',
		});
	});

	it('drops invalid user-message metadata fields at parse boundary', () => {
		const parsed = parseChatMessage({
			type: 'user-message',
			timestamp: TS,
			content: 'hello',
			metadata: {
				messageId: 123,
				clientRequestId: 'req-1',
				turnId: null,
				deliveryStatus: 'sent',
			},
		}) as UserMessage;

		expect(parsed).toBeInstanceOf(UserMessage);
		expect(parsed.metadata).toEqual({ clientRequestId: 'req-1' });
	});

	it('filters malformed user-message images at parse boundary', () => {
		const parsed = parseChatMessage({
			type: 'user-message',
			timestamp: TS,
			content: 'hello',
			images: [
				{ data: 'data:image/png;base64,abc', name: 'screenshot.png' },
				{ data: 123, name: 'bad.png' },
				{ data: 'data:image/png;base64,def' },
				null,
			],
		}) as UserMessage;

		expect(parsed).toBeInstanceOf(UserMessage);
		expect(parsed.images).toEqual([{ data: 'data:image/png;base64,abc', name: 'screenshot.png' }]);
	});

	it('parses bash-tool-use from wire data', () => {
		const data = { type: 'bash-tool-use', timestamp: TS, toolId: 'id-wire', command: 'echo hello' };
		const parsed = parseChatMessage(data);
		expect(parsed).toBeInstanceOf(BashToolUseMessage);
		expect((parsed as BashToolUseMessage).command).toBe('echo hello');
	});

	it('parses read-tool-use with numeric offset from wire data', () => {
		const data = {
			type: 'read-tool-use',
			timestamp: TS,
			toolId: 'id-str-num',
			filePath: '/tmp/x.ts',
			offset: '10',
			limit: '50',
		};
		const parsed = parseChatMessage(data) as ReadToolUseMessage;
		expect(parsed).toBeInstanceOf(ReadToolUseMessage);
		expect(parsed.filePath).toBe('/tmp/x.ts');
		expect(parsed.offset).toBe(10);
		expect(parsed.limit).toBe(50);
	});

	it('parses list-tool-use from wire data', () => {
		const data = {
			type: 'list-tool-use',
			timestamp: TS,
			toolId: 'id-list',
			path: '/tmp',
		};
		const parsed = parseChatMessage(data) as ListToolUseMessage;
		expect(parsed).toBeInstanceOf(ListToolUseMessage);
		expect(parsed.path).toBe('/tmp');
	});

	it('parses unknown-tool-use from wire data without metadata pollution', () => {
		const data = {
			type: 'unknown-tool-use',
			timestamp: TS,
			toolId: 'id-unk-wire',
			rawName: 'customX',
			input: { a: 1, b: 'two' },
		};
		const parsed = parseChatMessage(data) as UnknownToolUseMessage;
		expect(parsed).toBeInstanceOf(UnknownToolUseMessage);
		expect(parsed.rawName).toBe('customX');
		expect(parsed.input).toEqual({ a: 1, b: 'two' });
	});

	it('filters malformed edit changes at parse boundary', () => {
		const parsed = parseChatMessage({
			type: 'edit-tool-use',
			timestamp: TS,
			toolId: 'id-edit-wire',
			changes: [
				{ path: '/tmp/a.ts', kind: 'update' },
				{ path: 123, kind: 'create' },
				{ path: '/tmp/b.ts', kind: false },
				'bad',
			],
		}) as EditToolUseMessage;

		expect(parsed).toBeInstanceOf(EditToolUseMessage);
		expect(parsed.changes).toEqual([
			{ path: '/tmp/a.ts', kind: 'update' },
			{ kind: 'create' },
			{ path: '/tmp/b.ts' },
		]);
	});

	it('filters malformed exit-plan allowed prompts at parse boundary', () => {
		const parsed = parseChatMessage({
			type: 'exit-plan-mode-tool-use',
			timestamp: TS,
			toolId: 'id-plan-wire',
			plan: 'Implement it',
			allowedPrompts: [
				{ tool: 'Bash', prompt: 'run tests' },
				{ tool: 'Read', prompt: 123 },
				{ tool: false, prompt: 'bad' },
			],
		}) as ExitPlanModeToolUseMessage;

		expect(parsed).toBeInstanceOf(ExitPlanModeToolUseMessage);
		expect(parsed.allowedPrompts).toEqual([{ tool: 'Bash', prompt: 'run tests' }]);
	});
});

describe('unrecognized type returns null', () => {
	it('parseChatMessage returns null for type "tool-use"', () => {
		const msg = parseChatMessage({
			type: 'tool-use',
			timestamp: TS,
			toolId: 'id-bad',
			toolName: 'Bash',
			toolInput: { command: 'echo hello' },
		});
		expect(msg).toBeNull();
	});

	it('parseChatMessage returns null for completely unknown type', () => {
		const msg = parseChatMessage({
			type: 'nonexistent-type',
			timestamp: TS,
		});
		expect(msg).toBeNull();
	});
});

describe('malformed known-type payloads return null', () => {
	it('bash-tool-use without command returns null', () => {
		const msg = parseChatMessage({
			type: 'bash-tool-use',
			timestamp: TS,
			toolId: 'id-bad',
		});
		expect(msg).toBeNull();
	});

	it('read-tool-use without filePath returns null', () => {
		const msg = parseChatMessage({
			type: 'read-tool-use',
			timestamp: TS,
			toolId: 'id-bad',
		});
		expect(msg).toBeNull();
	});

	it('write-tool-use without filePath returns null', () => {
		const msg = parseChatMessage({
			type: 'write-tool-use',
			timestamp: TS,
			toolId: 'id-bad',
		});
		expect(msg).toBeNull();
	});

	it('web-search-tool-use without query returns null', () => {
		const msg = parseChatMessage({
			type: 'web-search-tool-use',
			timestamp: TS,
			toolId: 'id-bad',
		});
		expect(msg).toBeNull();
	});

	it('web-fetch-tool-use without url returns null', () => {
		const msg = parseChatMessage({
			type: 'web-fetch-tool-use',
			timestamp: TS,
			toolId: 'id-bad',
		});
		expect(msg).toBeNull();
	});

	it('exit-plan-mode-tool-use without plan returns null', () => {
		const msg = parseChatMessage({
			type: 'exit-plan-mode-tool-use',
			timestamp: TS,
			toolId: 'id-bad',
		});
		expect(msg).toBeNull();
	});

	it('codex-subagent-tool-use with unknown action returns null', () => {
		const msg = parseChatMessage({
			type: 'codex-subagent-tool-use',
			timestamp: TS,
			toolId: 'id-bad',
			action: 'launch_everything',
			details: {},
		});
		expect(msg).toBeNull();
	});
});

describe('direct constructor round-trip', () => {
	it('directly constructed messages survive JSON serialization', () => {
		const msg = new EditToolUseMessage(TS, 'id-factory', '/tmp/f.ts', 'a', 'b');
		const parsed = roundTrip(msg);
		expect(parsed.filePath).toBe('/tmp/f.ts');
		expect(parsed.oldString).toBe('a');
		expect(parsed.newString).toBe('b');
	});
});

describe('PermissionRequestMessage round-trip', () => {
	it('round-trips PermissionRequestMessage with Bash requestedTool', () => {
		const requestedTool = new BashToolUseMessage(TS, 'tool-1', 'ls -la');
		const msg = new PermissionRequestMessage(TS, 'perm-1', requestedTool);
		const parsed = roundTrip(msg) as PermissionRequestMessage;

		expect(parsed).toBeInstanceOf(PermissionRequestMessage);
		expect(parsed.requestedTool).toBeInstanceOf(BashToolUseMessage);
		expect((parsed.requestedTool as BashToolUseMessage).command).toBe('ls -la');
	});

	it('round-trips PermissionRequestMessage with ExitPlanMode requestedTool', () => {
		const requestedTool = new ExitPlanModeToolUseMessage(TS, 'tool-2', 'Do X', []);
		const msg = new PermissionRequestMessage(TS, 'perm-2', requestedTool);
		const parsed = roundTrip(msg) as PermissionRequestMessage;

		expect(parsed.requestedTool).toBeInstanceOf(ExitPlanModeToolUseMessage);
		expect((parsed.requestedTool as ExitPlanModeToolUseMessage).plan).toBe('Do X');
	});

	it('round-trips PermissionRequestMessage with UnknownToolUse requestedTool', () => {
		const requestedTool = new UnknownToolUseMessage(TS, 'tool-3', 'custom', { key: 'val' });
		const msg = new PermissionRequestMessage(TS, 'perm-3', requestedTool);
		const parsed = roundTrip(msg) as PermissionRequestMessage;

		expect(parsed.requestedTool).toBeInstanceOf(UnknownToolUseMessage);
		expect((parsed.requestedTool as UnknownToolUseMessage).rawName).toBe('custom');
	});

	it('returns null for permission-request with missing requestedTool', () => {
		const msg = parseChatMessage({
			type: 'permission-request',
			timestamp: TS,
			permissionRequestId: 'perm-bad',
		});
		expect(msg).toBeNull();
	});

	it('returns null for permission-request with non-tool requestedTool', () => {
		const msg = parseChatMessage({
			type: 'permission-request',
			timestamp: TS,
			permissionRequestId: 'perm-bad',
			requestedTool: { type: 'assistant-message', timestamp: TS, content: 'hi' },
		});
		expect(msg).toBeNull();
	});
});
