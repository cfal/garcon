import { describe, expect, it } from 'vitest';
import { resolveDisplayRule } from '../tool-display-policy';
import {
	TOOL_DISPLAY_REGISTRY,
	getToolDisplayDetails,
	getToolDisplayLabel,
} from '../tool-display-registry';
import {
	ApplyPatchToolUseMessage,
	AmpFinderToolUseMessage,
	AmpOracleToolUseMessage,
	BashToolUseMessage,
	ExternalToolUseMessage,
	ExitPlanModeToolUseMessage,
	ListToolUseMessage,
	McpToolUseMessage,
} from '$shared/chat-types';

describe('TOOL_DISPLAY_REGISTRY', () => {
	it('contains a default entry', () => {
		expect(TOOL_DISPLAY_REGISTRY.default).toBeDefined();
		expect(TOOL_DISPLAY_REGISTRY.default.input.mode).toBe('collapsible');
	});

	it('contains entries for explicit tool-use message types', () => {
		const expected = [
			'bash-tool-use',
			'read-tool-use',
			'list-tool-use',
			'edit-tool-use',
			'write-tool-use',
			'apply-patch-tool-use',
			'grep-tool-use',
			'glob-tool-use',
			'todo-write-tool-use',
			'todo-read-tool-use',
			'task-tool-use',
			'update-plan-tool-use',
			'write-stdin-tool-use',
			'enter-plan-mode-tool-use',
			'exit-plan-mode-tool-use',
			'web-search-tool-use',
			'web-fetch-tool-use',
			'amp-finder-tool-use',
			'amp-oracle-tool-use',
			'amp-librarian-tool-use',
			'amp-skill-tool-use',
			'amp-mermaid-tool-use',
			'amp-handoff-tool-use',
			'amp-look-at-tool-use',
			'amp-find-thread-tool-use',
			'amp-read-thread-tool-use',
			'amp-task-list-tool-use',
			'external-tool-use',
			'mcp-tool-use',
			'request-permissions-tool-use',
			'unknown-tool-use',
			'default',
		];
		for (const type of expected) {
			expect(TOOL_DISPLAY_REGISTRY[type]).toBeDefined();
		}
	});

	it('uses canonical type keys for core tools', () => {
		expect(TOOL_DISPLAY_REGISTRY['bash-tool-use'].input.mode).toBe('inline');
		expect(TOOL_DISPLAY_REGISTRY['read-tool-use'].input.mode).toBe('inline');
		expect(TOOL_DISPLAY_REGISTRY['list-tool-use'].input.mode).toBe('inline');
		expect(TOOL_DISPLAY_REGISTRY['edit-tool-use'].input.mode).toBe('collapsible');
		expect(TOOL_DISPLAY_REGISTRY['write-stdin-tool-use'].input.mode).toBe('hidden');
	});

	it('uses canonical type keys for Amp-specific tools', () => {
		expect(TOOL_DISPLAY_REGISTRY['amp-finder-tool-use'].input.mode).toBe('inline');
		expect(TOOL_DISPLAY_REGISTRY['amp-oracle-tool-use'].input.mode).toBe('collapsible');
		expect(TOOL_DISPLAY_REGISTRY['amp-task-list-tool-use'].input.label).toBe('Tasks');
	});

	it('resolves known type keys directly', () => {
		const rule = resolveDisplayRule(TOOL_DISPLAY_REGISTRY, 'bash-tool-use');
		expect(rule).toBe(TOOL_DISPLAY_REGISTRY['bash-tool-use']);
	});

	it('falls back to default for an unknown type', () => {
		const rule = resolveDisplayRule(TOOL_DISPLAY_REGISTRY, 'future-tool-use');
		expect(rule).toBe(TOOL_DISPLAY_REGISTRY.default);
	});
});

describe('tool display helpers', () => {
	it('returns the display label for generic tool-use messages', () => {
		const label = getToolDisplayLabel(new BashToolUseMessage('', 'tool-1', 'ls -la'));
		expect(label).toBe('Bash');
	});

	it('returns the display label for list tool-use messages', () => {
		const label = getToolDisplayLabel(new ListToolUseMessage('', 'tool-list-1', '/tmp'));
		expect(label).toBe('List');
	});

	it('returns structured external and MCP labels from typed fields', () => {
		expect(getToolDisplayLabel(new ExternalToolUseMessage('', 'tool-1', 'search', {}, 'app'))).toBe(
			'app.search',
		);
		expect(getToolDisplayLabel(new McpToolUseMessage('', 'tool-2', 'github', 'list_prs', {}))).toBe(
			'github.list_prs',
		);
	});

	it('returns the display label for Amp-specific tool-use messages', () => {
		const label = getToolDisplayLabel(new AmpFinderToolUseMessage('', 'tool-2', 'find auth'));
		expect(label).toBe('Finder');
	});

	it('strips transport metadata from display details', () => {
		const details = getToolDisplayDetails(
			new AmpOracleToolUseMessage('', 'tool-3', 'Review auth', 'Focus on session invalidation', [
				'src/auth.ts',
			]),
		);
		expect(details).toEqual({
			task: 'Review auth',
			context: 'Focus on session invalidation',
			files: ['src/auth.ts'],
		});
	});

	it('preserves plan content in display details', () => {
		const details = getToolDisplayDetails(
			new ExitPlanModeToolUseMessage('', 'tool-4', 'Implement the change.'),
		);
		expect(details).toEqual({
			plan: 'Implement the change.',
		});
	});

	it('shows patch-only ApplyPatch messages as diffs', () => {
		const message = new ApplyPatchToolUseMessage(
			'',
			'tool-5',
			undefined,
			undefined,
			undefined,
			'*** Begin Patch',
		);
		const props = TOOL_DISPLAY_REGISTRY['apply-patch-tool-use'].input.getContentProps?.(
			message as unknown as Record<string, unknown>,
		);
		expect(props).toMatchObject({
			oldContent: '',
			newContent: '*** Begin Patch',
			badge: 'Patch',
		});
	});

	it('coerces todo-read results through the shared todo normalizer', () => {
		const getContentProps = TOOL_DISPLAY_REGISTRY['todo-read-tool-use'].result?.getContentProps;
		expect(getContentProps).toBeDefined();
		if (!getContentProps) throw new Error('todo-read result renderer missing');

		const props = getContentProps({
			content: {
				items: [
					{ text: 'review code', status: 'in-progress' },
					{ step: 'ship fix', completed: true },
					{ note: 'ignored' },
				],
			},
		});

		expect(props).toEqual({
			isResult: true,
			todos: [
				{ content: 'review code', status: 'in_progress' },
				{ content: 'ship fix', status: 'completed' },
			],
		});
	});
});
