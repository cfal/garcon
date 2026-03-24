import { describe, it, expect } from 'vitest';
import { TOOL_DISPLAY_REGISTRY } from '../tool-display-registry';
import { resolveDisplayRule } from '../tool-display-policy';

describe('TOOL_DISPLAY_REGISTRY', () => {
	it('contains a Default entry', () => {
		expect(TOOL_DISPLAY_REGISTRY.Default).toBeDefined();
		expect(TOOL_DISPLAY_REGISTRY.Default.input.mode).toBe('collapsible');
	});

	it('contains entries for all core tools', () => {
		const expected = [
			'Bash', 'Read', 'Edit', 'Write', 'ApplyPatch',
			'Grep', 'Glob', 'TodoWrite', 'TodoRead',
			'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet', 'Task',
			'exit_plan_mode', 'ExitPlanMode',
			'WebSearch', 'WebFetch', 'WriteStdin', 'UpdatePlan', 'Default',
			'finder', 'oracle', 'librarian', 'skill', 'mermaid', 'handoff',
			'look_at', 'read_web_page', 'web_search', 'find_thread', 'read_thread', 'task_list',
		];
		for (const name of expected) {
			expect(TOOL_DISPLAY_REGISTRY[name]).toBeDefined();
		}
	});

	describe('mode field uses canonical values', () => {
		it('Bash uses inline mode', () => {
			expect(TOOL_DISPLAY_REGISTRY.Bash.input.mode).toBe('inline');
		});

		it('Read uses inline mode', () => {
			expect(TOOL_DISPLAY_REGISTRY.Read.input.mode).toBe('inline');
		});

		it('Edit uses collapsible mode', () => {
			expect(TOOL_DISPLAY_REGISTRY.Edit.input.mode).toBe('collapsible');
		});

		it('WriteStdin uses hidden mode', () => {
			expect(TOOL_DISPLAY_REGISTRY.WriteStdin.input.mode).toBe('hidden');
		});

		it('Default uses collapsible mode', () => {
			expect(TOOL_DISPLAY_REGISTRY.Default.input.mode).toBe('collapsible');
		});
	});

	describe('action field uses canonical ToolInlineAction values', () => {
		it('Bash uses copyValue', () => {
			expect(TOOL_DISPLAY_REGISTRY.Bash.input.action).toBe('copyValue');
		});

		it('Read uses openFile', () => {
			expect(TOOL_DISPLAY_REGISTRY.Read.input.action).toBe('openFile');
		});

		it('Glob uses jumpToResult', () => {
			expect(TOOL_DISPLAY_REGISTRY.Glob.input.action).toBe('jumpToResult');
		});

		it('WebSearch uses jumpToResult', () => {
			expect(TOOL_DISPLAY_REGISTRY.WebSearch.input.action).toBe('jumpToResult');
		});

		it('Grep uses none', () => {
			expect(TOOL_DISPLAY_REGISTRY.Grep.input.action).toBe('none');
		});
	});

	describe('contentKind field uses camelCase values', () => {
		it('Edit input uses diff', () => {
			expect(TOOL_DISPLAY_REGISTRY.Edit.input.contentKind).toBe('diff');
		});

		it('Grep result uses fileList', () => {
			expect(TOOL_DISPLAY_REGISTRY.Grep.result?.contentKind).toBe('fileList');
		});

		it('Glob result uses fileList', () => {
			expect(TOOL_DISPLAY_REGISTRY.Glob.result?.contentKind).toBe('fileList');
		});

		it('TodoWrite input uses todoList', () => {
			expect(TOOL_DISPLAY_REGISTRY.TodoWrite.input.contentKind).toBe('todoList');
		});

		it('TodoWrite result uses successMessage', () => {
			expect(TOOL_DISPLAY_REGISTRY.TodoWrite.result?.contentKind).toBe('successMessage');
		});

		it('ExitPlanMode input uses markdown', () => {
			expect(TOOL_DISPLAY_REGISTRY.ExitPlanMode.input.contentKind).toBe('markdown');
		});

		it('Default input uses text', () => {
			expect(TOOL_DISPLAY_REGISTRY.Default.input.contentKind).toBe('text');
		});

		it('TaskList result uses task', () => {
			expect(TOOL_DISPLAY_REGISTRY.TaskList.result?.contentKind).toBe('task');
		});
	});

	describe('result mode uses canonical values', () => {
		it('Bash result uses special mode', () => {
			expect(TOOL_DISPLAY_REGISTRY.Bash.result?.mode).toBe('special');
		});

		it('Grep result uses collapsible mode', () => {
			expect(TOOL_DISPLAY_REGISTRY.Grep.result?.mode).toBe('collapsible');
		});
	});

	describe('result visibility rules', () => {
		it('Read result is hidden', () => {
			expect(TOOL_DISPLAY_REGISTRY.Read.result?.hidden).toBe(true);
		});

		it('Write result hides on success', () => {
			expect(TOOL_DISPLAY_REGISTRY.Write.result?.hideOnSuccess).toBe(true);
		});

		it('WriteStdin result is hidden', () => {
			expect(TOOL_DISPLAY_REGISTRY.WriteStdin.result?.hidden).toBe(true);
		});
	});

	describe('getValue produces expected output', () => {
		it('Bash getValue returns command', () => {
			const value = TOOL_DISPLAY_REGISTRY.Bash.input.getValue!({ command: 'ls -la' });
			expect(value).toBe('ls -la');
		});

		it('Read getValue returns file path', () => {
			const value = TOOL_DISPLAY_REGISTRY.Read.input.getValue!({ file_path: '/tmp/test.ts' });
			expect(value).toBe('/tmp/test.ts');
		});

		it('Glob getValue returns pattern', () => {
			const value = TOOL_DISPLAY_REGISTRY.Glob.input.getValue!({ pattern: '**/*.ts' });
			expect(value).toBe('**/*.ts');
		});

		it('Grep getValue returns basename from path', () => {
			const value = TOOL_DISPLAY_REGISTRY.Grep.input.getValue!({ path: '/tmp/test/file.ts' });
			expect(value).toBe('file.ts');
		});

		it('Grep getValue falls back when path is missing', () => {
			const value = TOOL_DISPLAY_REGISTRY.Grep.input.getValue!({});
			expect(value).toBe('project files');
		});

		it('WebSearch getValue returns query', () => {
			const value = TOOL_DISPLAY_REGISTRY.WebSearch.input.getValue!({ query: 'svelte 5' });
			expect(value).toBe('svelte 5');
		});
	});

	describe('exit_plan_mode aliases ExitPlanMode', () => {
		it('both entries reference the same rule object', () => {
			expect(TOOL_DISPLAY_REGISTRY.exit_plan_mode).toBe(
				TOOL_DISPLAY_REGISTRY.ExitPlanMode,
			);
		});
	});

	describe('agent tool display rules', () => {
		it('finder uses inline mode with search label', () => {
			const rule = TOOL_DISPLAY_REGISTRY.finder;
			expect(rule.input.mode).toBe('inline');
			expect(rule.input.label).toBe('Search');
			expect(rule.input.getValue!({ query: 'find auth handlers' })).toBe('find auth handlers');
		});

		it('oracle uses collapsible mode with task in title', () => {
			const rule = TOOL_DISPLAY_REGISTRY.oracle;
			expect(rule.input.mode).toBe('collapsible');
			const title = typeof rule.input.title === 'function' ? rule.input.title({ task: 'Review auth flow' }) : rule.input.title;
			expect(title).toContain('Oracle');
			expect(title).toContain('Review auth flow');
		});

		it('librarian uses collapsible mode with query in title', () => {
			const rule = TOOL_DISPLAY_REGISTRY.librarian;
			expect(rule.input.mode).toBe('collapsible');
			const title = typeof rule.input.title === 'function' ? rule.input.title({ query: 'How does auth work' }) : rule.input.title;
			expect(title).toContain('Librarian');
			expect(title).toContain('How does auth work');
		});

		it('skill uses inline mode with skill name', () => {
			const rule = TOOL_DISPLAY_REGISTRY.skill;
			expect(rule.input.mode).toBe('inline');
			expect(rule.input.label).toBe('Skill');
			expect(rule.input.getValue!({ name: 'lsp' })).toBe('lsp');
			expect(rule.result?.hidden).toBe(true);
		});

		it('mermaid uses inline mode', () => {
			const rule = TOOL_DISPLAY_REGISTRY.mermaid;
			expect(rule.input.mode).toBe('inline');
			expect(rule.result?.hidden).toBe(true);
		});

		it('handoff uses inline mode with goal', () => {
			const rule = TOOL_DISPLAY_REGISTRY.handoff;
			expect(rule.input.mode).toBe('inline');
			expect(rule.input.label).toBe('Handoff');
			expect(rule.result?.hidden).toBe(true);
		});

		it('look_at uses inline mode with file path', () => {
			const rule = TOOL_DISPLAY_REGISTRY.look_at;
			expect(rule.input.mode).toBe('inline');
			expect(rule.input.label).toBe('Analyze');
			expect(rule.input.getValue!({ path: '/home/user/project/image.png' })).toBe('image.png');
		});

		it('read_web_page aliases WebFetch', () => {
			expect(TOOL_DISPLAY_REGISTRY.read_web_page).toBe(TOOL_DISPLAY_REGISTRY.WebFetch);
		});

		it('web_search aliases WebSearch', () => {
			expect(TOOL_DISPLAY_REGISTRY.web_search).toBe(TOOL_DISPLAY_REGISTRY.WebSearch);
		});

		it('find_thread uses inline mode with query', () => {
			const rule = TOOL_DISPLAY_REGISTRY.find_thread;
			expect(rule.input.mode).toBe('inline');
			expect(rule.input.label).toBe('Threads');
		});

		it('read_thread uses inline mode with thread ID', () => {
			const rule = TOOL_DISPLAY_REGISTRY.read_thread;
			expect(rule.input.mode).toBe('inline');
			expect(rule.input.label).toBe('Thread');
			expect(rule.input.getValue!({ threadID: 'T-abc123' })).toBe('T-abc123');
		});

		it('task_list uses inline mode', () => {
			const rule = TOOL_DISPLAY_REGISTRY.task_list;
			expect(rule.input.mode).toBe('inline');
			expect(rule.input.label).toBe('Tasks');
		});
	});

	describe('resolveDisplayRule integration', () => {
		it('resolves known tool names', () => {
			const rule = resolveDisplayRule(TOOL_DISPLAY_REGISTRY, 'Bash');
			expect(rule).toBe(TOOL_DISPLAY_REGISTRY.Bash);
		});

		it('falls back to Default for unknown tools', () => {
			const rule = resolveDisplayRule(TOOL_DISPLAY_REGISTRY, 'NonExistentTool');
			expect(rule).toBe(TOOL_DISPLAY_REGISTRY.Default);
		});
	});
});
