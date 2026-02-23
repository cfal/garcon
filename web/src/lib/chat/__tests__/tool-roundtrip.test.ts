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
		const msg = new BashToolUseMessage(TS, 'id-1', 'Bash', 'ls -la', 'List files');
		const parsed = roundTrip(msg);
		expect(parsed.command).toBe('ls -la');
		expect(parsed.description).toBe('List files');
		expect(parsed.rawName).toBe('Bash');
	});

	it('ReadToolUseMessage preserves filePath and range fields', () => {
		const msg = new ReadToolUseMessage(TS, 'id-2', 'Read', '/tmp/test.ts', 10, 50, 60);
		const parsed = roundTrip(msg);
		expect(parsed.filePath).toBe('/tmp/test.ts');
		expect(parsed.offset).toBe(10);
		expect(parsed.limit).toBe(50);
		expect(parsed.endLine).toBe(60);
	});

	it('EditToolUseMessage preserves diff fields', () => {
		const msg = new EditToolUseMessage(TS, 'id-3', 'Edit', '/tmp/a.ts', 'old', 'new');
		const parsed = roundTrip(msg);
		expect(parsed.filePath).toBe('/tmp/a.ts');
		expect(parsed.oldString).toBe('old');
		expect(parsed.newString).toBe('new');
	});

	it('EditToolUseMessage preserves changes array', () => {
		const changes = [{ path: '/tmp/b.ts', kind: 'update' }];
		const msg = new EditToolUseMessage(TS, 'id-4', 'Edit', undefined, undefined, undefined, changes);
		const parsed = roundTrip(msg);
		expect(parsed.changes).toEqual(changes);
	});

	it('WriteToolUseMessage preserves filePath and content', () => {
		const msg = new WriteToolUseMessage(TS, 'id-5', 'Write', '/tmp/out.ts', 'file content');
		const parsed = roundTrip(msg);
		expect(parsed.filePath).toBe('/tmp/out.ts');
		expect(parsed.content).toBe('file content');
	});

	it('ApplyPatchToolUseMessage preserves diff fields', () => {
		const msg = new ApplyPatchToolUseMessage(TS, 'id-6', 'ApplyPatch', '/tmp/p.ts', 'before', 'after');
		const parsed = roundTrip(msg);
		expect(parsed.filePath).toBe('/tmp/p.ts');
		expect(parsed.oldString).toBe('before');
		expect(parsed.newString).toBe('after');
	});

	it('GrepToolUseMessage preserves pattern and path', () => {
		const msg = new GrepToolUseMessage(TS, 'id-7', 'Grep', 'TODO', '/src');
		const parsed = roundTrip(msg);
		expect(parsed.pattern).toBe('TODO');
		expect(parsed.path).toBe('/src');
	});

	it('GlobToolUseMessage preserves pattern and path', () => {
		const msg = new GlobToolUseMessage(TS, 'id-8', 'Glob', '**/*.ts', '/src');
		const parsed = roundTrip(msg);
		expect(parsed.pattern).toBe('**/*.ts');
		expect(parsed.path).toBe('/src');
	});

	it('WebSearchToolUseMessage preserves query', () => {
		const msg = new WebSearchToolUseMessage(TS, 'id-9', 'WebSearch', 'svelte 5 runes');
		const parsed = roundTrip(msg);
		expect(parsed.query).toBe('svelte 5 runes');
	});

	it('WebFetchToolUseMessage preserves url and prompt', () => {
		const msg = new WebFetchToolUseMessage(TS, 'id-10', 'WebFetch', 'https://example.com', 'summarize');
		const parsed = roundTrip(msg);
		expect(parsed.url).toBe('https://example.com');
		expect(parsed.prompt).toBe('summarize');
	});

	it('TodoWriteToolUseMessage preserves todos', () => {
		const todos = [{ content: 'task 1', status: 'pending' }];
		const msg = new TodoWriteToolUseMessage(TS, 'id-11', 'TodoWrite', todos);
		const parsed = roundTrip(msg);
		expect(parsed.todos).toEqual(todos);
	});

	it('TodoReadToolUseMessage round-trips', () => {
		const msg = new TodoReadToolUseMessage(TS, 'id-12', 'TodoRead');
		const parsed = roundTrip(msg);
		expect(parsed.rawName).toBe('TodoRead');
	});

	it('TaskToolUseMessage preserves all fields', () => {
		const msg = new TaskToolUseMessage(TS, 'id-13', 'Task', 'Explore', 'Find files', 'search for X', 'sonnet');
		const parsed = roundTrip(msg);
		expect(parsed.subagentType).toBe('Explore');
		expect(parsed.description).toBe('Find files');
		expect(parsed.prompt).toBe('search for X');
		expect(parsed.model).toBe('sonnet');
	});

	it('UpdatePlanToolUseMessage preserves todos', () => {
		const msg = new UpdatePlanToolUseMessage(TS, 'id-14', 'UpdatePlan', [{ text: 'step 1' }]);
		const parsed = roundTrip(msg);
		expect(parsed.todos).toEqual([{ text: 'step 1' }]);
	});

	it('WriteStdinToolUseMessage preserves input record', () => {
		const msg = new WriteStdinToolUseMessage(TS, 'id-15', 'WriteStdin', { session_id: 42 });
		const parsed = roundTrip(msg);
		expect(parsed.rawName).toBe('WriteStdin');
	});

	it('EnterPlanModeToolUseMessage round-trips', () => {
		const msg = new EnterPlanModeToolUseMessage(TS, 'id-16', 'EnterPlanMode');
		const parsed = roundTrip(msg);
		expect(parsed.rawName).toBe('EnterPlanMode');
	});

	it('ExitPlanModeToolUseMessage preserves plan and allowedPrompts', () => {
		const prompts = [{ tool: 'Bash', prompt: 'run tests' }];
		const msg = new ExitPlanModeToolUseMessage(TS, 'id-17', 'ExitPlanMode', 'The plan text', prompts);
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

describe('legacy wire format (toolName + toolInput)', () => {
	it('parses legacy Bash format with toolName and toolInput', () => {
		const legacy = {
			type: 'tool-use',
			timestamp: TS,
			toolId: 'id-legacy',
			toolName: 'Bash',
			toolInput: { command: 'echo hello' },
		};
		const parsed = parseChatMessage(legacy);
		expect(parsed).toBeInstanceOf(BashToolUseMessage);
		expect((parsed as BashToolUseMessage).command).toBe('echo hello');
	});

	it('parses legacy Read format with string numeric offset', () => {
		const legacy = {
			type: 'tool-use',
			timestamp: TS,
			toolId: 'id-str-num',
			toolName: 'Read',
			toolInput: { file_path: '/tmp/x.ts', offset: '10', limit: '50' },
		};
		const parsed = parseChatMessage(legacy) as ReadToolUseMessage;
		expect(parsed).toBeInstanceOf(ReadToolUseMessage);
		expect(parsed.filePath).toBe('/tmp/x.ts');
		expect(parsed.offset).toBe(10);
		expect(parsed.limit).toBe(50);
	});

	it('parses legacy unknown tool without metadata pollution', () => {
		const legacy = {
			type: 'tool-use',
			timestamp: TS,
			toolId: 'id-unk-legacy',
			toolName: 'customX',
			toolInput: { a: 1, b: 'two' },
		};
		const parsed = parseChatMessage(legacy) as UnknownToolUseMessage;
		expect(parsed).toBeInstanceOf(UnknownToolUseMessage);
		expect(parsed.rawName).toBe('customX');
		// Must contain only tool payload -- no message envelope keys
		expect(parsed.input).toEqual({ a: 1, b: 'two' });
		expect(parsed.input).not.toHaveProperty('type');
		expect(parsed.input).not.toHaveProperty('timestamp');
		expect(parsed.input).not.toHaveProperty('toolId');
		expect(parsed.input).not.toHaveProperty('toolName');
		expect(parsed.input).not.toHaveProperty('toolInput');
	});
});

describe('malformed known-tool fallback', () => {
	it('Bash with missing command falls back to UnknownToolUseMessage', () => {
		const msg = parseChatMessage({
			type: 'tool-use',
			timestamp: TS,
			toolId: 'id-bad-bash',
			toolName: 'Bash',
			toolInput: { description: 'no command here' },
		});
		expect(msg).toBeInstanceOf(UnknownToolUseMessage);
		expect((msg as UnknownToolUseMessage).rawName).toBe('Bash');
	});

	it('Read with missing file_path falls back to UnknownToolUseMessage', () => {
		const msg = parseChatMessage({
			type: 'tool-use',
			timestamp: TS,
			toolId: 'id-bad-read',
			toolName: 'Read',
			toolInput: { offset: 10 },
		});
		expect(msg).toBeInstanceOf(UnknownToolUseMessage);
	});

	it('WebSearch with missing query falls back to UnknownToolUseMessage', () => {
		const msg = parseChatMessage({
			type: 'tool-use',
			timestamp: TS,
			toolId: 'id-bad-ws',
			toolName: 'WebSearch',
			toolInput: {},
		});
		expect(msg).toBeInstanceOf(UnknownToolUseMessage);
	});

	it('WebFetch with missing url falls back to UnknownToolUseMessage', () => {
		const msg = parseChatMessage({
			type: 'tool-use',
			timestamp: TS,
			toolId: 'id-bad-wf',
			toolName: 'WebFetch',
			toolInput: { prompt: 'summarize' },
		});
		expect(msg).toBeInstanceOf(UnknownToolUseMessage);
	});

	it('Write with missing file_path falls back to UnknownToolUseMessage', () => {
		const msg = parseChatMessage({
			type: 'tool-use',
			timestamp: TS,
			toolId: 'id-bad-write',
			toolName: 'Write',
			toolInput: { content: 'some content' },
		});
		expect(msg).toBeInstanceOf(UnknownToolUseMessage);
	});

	it('ExitPlanMode with missing plan falls back to UnknownToolUseMessage', () => {
		const msg = parseChatMessage({
			type: 'tool-use',
			timestamp: TS,
			toolId: 'id-bad-epm',
			toolName: 'ExitPlanMode',
			toolInput: {},
		});
		expect(msg).toBeInstanceOf(UnknownToolUseMessage);
	});

	it('Edit with all-optional fields still produces EditToolUseMessage', () => {
		const msg = parseChatMessage({
			type: 'tool-use',
			timestamp: TS,
			toolId: 'id-edit-empty',
			toolName: 'Edit',
			toolInput: {},
		});
		expect(msg).toBeInstanceOf(EditToolUseMessage);
	});
});

describe('direct constructor round-trip', () => {
	it('directly constructed messages survive JSON serialization', () => {
		const msg = new EditToolUseMessage(TS, 'id-factory', 'Edit', '/tmp/f.ts', 'a', 'b');
		const parsed = roundTrip(msg);
		expect(parsed.filePath).toBe('/tmp/f.ts');
		expect(parsed.oldString).toBe('a');
		expect(parsed.newString).toBe('b');
	});
});
