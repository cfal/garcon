import { describe, it, expect } from 'vitest';
import {
	BashToolUseMessage,
	ReadToolUseMessage,
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
	UpdatePlanToolUseMessage,
	WriteStdinToolUseMessage,
	EnterPlanModeToolUseMessage,
	ExitPlanModeToolUseMessage,
	UnknownToolUseMessage,
	PermissionRequestMessage,
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
		const msg = new ApplyPatchToolUseMessage(TS, 'id-6', '/tmp/p.ts', 'before', 'after');
		const parsed = roundTrip(msg);
		expect(parsed.filePath).toBe('/tmp/p.ts');
		expect(parsed.oldString).toBe('before');
		expect(parsed.newString).toBe('after');
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
		const msg = new TaskToolUseMessage(TS, 'id-13', 'Explore', 'Find files', 'search for X', 'sonnet');
		const parsed = roundTrip(msg);
		expect(parsed.subagentType).toBe('Explore');
		expect(parsed.description).toBe('Find files');
		expect(parsed.prompt).toBe('search for X');
		expect(parsed.model).toBe('sonnet');
	});

	it('UpdatePlanToolUseMessage preserves todos', () => {
		const msg = new UpdatePlanToolUseMessage(TS, 'id-14', [{ content: 'step 1', status: 'pending' as const }]);
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

	it('UnknownToolUseMessage preserves rawName and input without metadata', () => {
		const msg = new UnknownToolUseMessage(TS, 'id-18', 'custom_tool', { key: 'val' });
		const parsed = roundTrip(msg);
		expect(parsed.rawName).toBe('custom_tool');
		expect(parsed.input).toEqual({ key: 'val' });
	});
});

describe('wire format parsing', () => {
	it('parses bash-tool-use from wire data', () => {
		const data = { type: 'bash-tool-use', timestamp: TS, toolId: 'id-legacy', command: 'echo hello' };
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

	it('parses unknown-tool-use from wire data without metadata pollution', () => {
		const data = {
			type: 'unknown-tool-use',
			timestamp: TS,
			toolId: 'id-unk-legacy',
			rawName: 'customX',
			input: { a: 1, b: 'two' },
		};
		const parsed = parseChatMessage(data) as UnknownToolUseMessage;
		expect(parsed).toBeInstanceOf(UnknownToolUseMessage);
		expect(parsed.rawName).toBe('customX');
		expect(parsed.input).toEqual({ a: 1, b: 'two' });
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
