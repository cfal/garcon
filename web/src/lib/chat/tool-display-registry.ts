// Registry mapping explicit tool-use message types to display rules.
// Known provider-specific tools must arrive here as typed messages.

import type { ToolUseChatMessage, TodoStatus } from '$shared/chat-types';
import * as m from '$lib/paraglide/messages.js';
import type { TodoItem } from '$lib/types/chat';
import type { ToolDisplayRule } from './tool-display-contract';
import {
	diffProps,
	extractContentString,
	fileTitlePresenter,
	readRangePresenter,
	webFetchSecondaryPresenter,
} from './tool-display-presenters';

type ToolDisplayRegistry = Record<string, ToolDisplayRule>;

function coerceTodoResult(raw: unknown): TodoItem[] | undefined {
	if (!Array.isArray(raw)) return undefined;
	const items: TodoItem[] = [];
	for (const entry of raw) {
		if (entry == null || typeof entry !== 'object') continue;
		const obj = entry as Record<string, unknown>;
		const content = (obj.content ?? obj.text ?? obj.step) as string | undefined;
		if (typeof content !== 'string') continue;
		const s = obj.status;
		const completed = obj.completed;
		const status: TodoStatus =
			completed === true || s === 'completed' || s === 'done'
				? 'completed'
				: s === 'in_progress' || s === 'in-progress'
					? 'in_progress'
					: 'pending';
		items.push({ content, status });
	}
	return items.length > 0 ? items : undefined;
}

const truncate = (s: string, n: number) => (s.length > n ? s.slice(0, n) + '...' : s);

const DISPLAY_NAME_BY_TYPE: Record<string, string> = {
	'bash-tool-use': 'Bash',
	'read-tool-use': 'Read',
	'edit-tool-use': 'Edit',
	'write-tool-use': 'Write',
	'apply-patch-tool-use': 'ApplyPatch',
	'grep-tool-use': 'Grep',
	'glob-tool-use': 'Glob',
	'web-search-tool-use': 'WebSearch',
	'web-fetch-tool-use': 'WebFetch',
	'todo-write-tool-use': 'TodoWrite',
	'todo-read-tool-use': 'TodoRead',
	'task-tool-use': 'Task',
	'update-plan-tool-use': 'UpdatePlan',
	'write-stdin-tool-use': 'WriteStdin',
	'enter-plan-mode-tool-use': 'EnterPlanMode',
	'exit-plan-mode-tool-use': 'ExitPlanMode',
	'amp-finder-tool-use': 'Finder',
	'amp-oracle-tool-use': 'Oracle',
	'amp-librarian-tool-use': 'Librarian',
	'amp-skill-tool-use': 'Skill',
	'amp-mermaid-tool-use': 'Mermaid',
	'amp-handoff-tool-use': 'Handoff',
	'amp-look-at-tool-use': 'Analyze',
	'amp-find-thread-tool-use': 'Threads',
	'amp-read-thread-tool-use': 'Thread',
	'amp-task-list-tool-use': 'Tasks',
};

function fallbackDisplayName(type: string): string {
	return type
		.replace(/-tool-use$/, '')
		.split('-')
		.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
		.join(' ');
}

const EXIT_PLAN_MODE_RULE: ToolDisplayRule = {
	input: {
		mode: 'collapsible',
		label: 'Implementation plan',
		title: 'Implementation plan',
		defaultOpen: true,
		contentKind: 'markdown',
		getContentProps: (input) => ({
			content: String(input.plan ?? '').replace(/\\n/g, '\n') || String(input.plan ?? ''),
		}),
	},
	result: {
		hidden: true,
	},
};

const WEB_SEARCH_RULE: ToolDisplayRule = {
	input: {
		mode: 'inline',
		label: 'WebSearch',
		getValue: (input) => String(input.query ?? ''),
		action: 'jumpToResult',
		colorScheme: {
			primary: 'text-foreground',
			secondary: 'text-muted-foreground',
			background: '',
			border: 'border-status-neutral-border',
		},
	},
	result: {
		mode: 'collapsible',
		defaultOpen: false,
		contentKind: 'text',
		getContentProps: (result) => ({
			content: extractContentString(result?.content),
			format: 'plain',
		}),
	},
};

const WEB_FETCH_RULE: ToolDisplayRule = {
	input: {
		mode: 'inline',
		label: m.chat_tool_web_fetch_label(),
		getValue: (input) => String(input.url ?? ''),
		getSecondary: (input) => webFetchSecondaryPresenter(input),
		action: 'none',
		colorScheme: {
			primary: 'text-foreground',
			secondary: 'text-muted-foreground',
			background: '',
			border: 'border-status-neutral-border',
		},
	},
	result: {
		mode: 'collapsible',
		defaultOpen: false,
		contentKind: 'text',
		getContentProps: (result) => ({
			content: extractContentString(result?.content),
			format: 'plain',
		}),
	},
};

export const TOOL_DISPLAY_REGISTRY: ToolDisplayRegistry = {
	'bash-tool-use': {
		input: {
			mode: 'inline',
			label: 'Bash',
			getValue: (input) => String(input.command ?? ''),
			getSecondary: (input) => input.description as string | undefined,
			action: 'copyValue',
			style: 'terminal',
			wrapText: true,
			colorScheme: {
				primary: 'text-foreground font-mono',
				secondary: 'text-muted-foreground',
				background: '',
				border: 'border-status-success-border',
			},
		},
		result: {
			hideOnSuccess: true,
			mode: 'special',
		},
	},

	'read-tool-use': {
		input: {
			mode: 'inline',
			label: 'Read',
			getValue: (input) => String(input.filePath ?? ''),
			getSecondary: (input) => readRangePresenter(input),
			action: 'openFile',
			colorScheme: {
				primary: 'text-foreground',
				background: '',
				border: 'border-border',
			},
		},
		result: {
			hidden: true,
		},
	},

	'edit-tool-use': {
		input: {
			mode: 'collapsible',
			label: 'Edit',
			title: (input) => {
				const fp = input.filePath as string | undefined;
				const changes = Array.isArray(input.changes)
					? (input.changes as Array<{ path?: unknown }>)
					: [];
				if (!fp && changes.length > 0) {
					if (changes.length === 1) {
						const onlyPath = String(changes[0]?.path ?? '').trim();
						if (onlyPath) return onlyPath.split('/').pop() || onlyPath;
					}
					return `${changes.length} files`;
				}
				return fp?.split('/').pop() || fp || 'file';
			},
			defaultOpen: false,
			contentKind: 'diff',
			actionButton: 'none',
			getContentProps: (input) => {
				const changes = Array.isArray(input.changes)
					? (input.changes as Array<{ path?: unknown }>)
					: [];
				if (!input.filePath && !input.oldString && !input.newString && changes.length > 0) {
					const files = changes
						.map((change) => String(change?.path ?? '').trim())
						.filter(Boolean);
					return { diffUnavailable: true, files };
				}
				return diffProps(input, 'Edit', 'gray');
			},
		},
		result: {
			hideOnSuccess: true,
		},
	},

	'write-tool-use': {
		input: {
			mode: 'collapsible',
			label: 'Write',
			title: fileTitlePresenter,
			defaultOpen: false,
			contentKind: 'diff',
			actionButton: 'none',
			getContentProps: (input) => ({
				oldContent: '',
				newContent: input.content,
				filePath: input.filePath,
				badge: 'New',
				badgeColor: 'green',
			}),
		},
		result: {
			hideOnSuccess: true,
		},
	},

	'apply-patch-tool-use': {
		input: {
			mode: 'collapsible',
			label: 'ApplyPatch',
			title: fileTitlePresenter,
			defaultOpen: false,
			contentKind: 'diff',
			actionButton: 'none',
			getContentProps: (input) => diffProps(input, 'Patch', 'gray'),
		},
		result: {
			hideOnSuccess: true,
		},
	},

	'grep-tool-use': {
		input: {
			mode: 'inline',
			label: 'Grep',
			getValue: (input) => {
				const rawPath = String(input.path ?? '');
				if (!rawPath) return 'project files';
				return rawPath.split(/[\\/]/).pop() || rawPath;
			},
			getSecondary: (input) => {
				const pattern = String(input.pattern ?? '').trim();
				return pattern ? `Pattern: ${pattern}` : undefined;
			},
			action: 'none',
			colorScheme: {
				primary: 'text-foreground',
				secondary: 'text-muted-foreground',
				background: '',
				border: 'border-status-neutral-border',
			},
		},
		result: {
			mode: 'collapsible',
			defaultOpen: false,
			title: (result) => {
				const content = (result?.content || {}) as Record<string, unknown>;
				const toolData = (content.toolUseResult || content) as Record<string, unknown>;
				const count =
					(toolData.numFiles as number) ||
					(toolData.filenames as unknown[] | undefined)?.length ||
					0;
				return `Found ${count} ${count === 1 ? 'file' : 'files'}`;
			},
			contentKind: 'fileList',
			getContentProps: (result) => {
				const content = (result?.content || {}) as Record<string, unknown>;
				const toolData = (content.toolUseResult || content) as Record<string, unknown>;
				return {
					files: (toolData.filenames as string[]) || [],
				};
			},
		},
	},

	'glob-tool-use': {
		input: {
			mode: 'inline',
			label: 'Glob',
			getValue: (input) => String(input.pattern ?? ''),
			getSecondary: (input) => (input.path ? `in ${input.path}` : undefined),
			action: 'jumpToResult',
			colorScheme: {
				primary: 'text-foreground',
				secondary: 'text-muted-foreground',
				background: '',
				border: 'border-status-neutral-border',
			},
		},
		result: {
			mode: 'collapsible',
			defaultOpen: false,
			title: (result) => {
				const content = (result?.content || {}) as Record<string, unknown>;
				const toolData = (content.toolUseResult || content) as Record<string, unknown>;
				const count =
					(toolData.numFiles as number) ||
					(toolData.filenames as unknown[] | undefined)?.length ||
					0;
				return `Found ${count} ${count === 1 ? 'file' : 'files'}`;
			},
			contentKind: 'fileList',
			getContentProps: (result) => {
				const content = (result?.content || {}) as Record<string, unknown>;
				const toolData = (content.toolUseResult || content) as Record<string, unknown>;
				return {
					files: (toolData.filenames as string[]) || [],
				};
			},
		},
	},

	'todo-write-tool-use': {
		input: {
			mode: 'collapsible',
			label: 'TodoWrite',
			title: 'Updating todo list',
			defaultOpen: true,
			contentKind: 'todoList',
			getContentProps: (input) => ({
				todos: input.todos,
			}),
		},
		result: {
			mode: 'collapsible',
			contentKind: 'successMessage',
			getMessage: () => 'Todo list updated',
		},
	},

	'todo-read-tool-use': {
		input: {
			mode: 'inline',
			label: 'TodoRead',
			getValue: () => 'reading list',
			action: 'none',
			colorScheme: {
				primary: 'text-muted-foreground',
				border: 'border-status-info-border',
			},
		},
		result: {
			mode: 'collapsible',
			contentKind: 'todoList',
			getContentProps: (result) => {
				const content = (result?.content || {}) as Record<string, unknown>;
				const todos = coerceTodoResult(content.items || content.todos);
				return { todos, isResult: true };
			},
		},
	},

	'task-tool-use': {
		input: {
			mode: 'collapsible',
			label: 'Task',
			title: (input) => {
				const subagentType = input.subagentType || 'Agent';
				const description = input.description || 'Running task';
				return `Subagent / ${subagentType}: ${description}`;
			},
			defaultOpen: true,
			contentKind: 'markdown',
			getContentProps: (input) => {
				const hasOnlyPrompt = input.prompt && !input.model && !input.resume;
				if (hasOnlyPrompt) return { content: input.prompt || '' };
				const parts: string[] = [];
				if (input.model) parts.push(`**Model:** ${input.model}`);
				if (input.prompt) parts.push(`**Prompt:**\n${input.prompt}`);
				if (input.resume) parts.push(`**Resuming from:** ${input.resume}`);
				return { content: parts.join('\n\n') };
			},
			colorScheme: {
				border: 'border-status-info-border',
			},
		},
		result: {
			mode: 'collapsible',
			title: (result) => {
				const content = (result?.content || {}) as Record<string, unknown>;
				return Array.isArray(content.items) ? 'Subagent Response' : 'Subagent Result';
			},
			defaultOpen: true,
			contentKind: 'markdown',
			getContentProps: (result) => {
				const content = (result?.content || {}) as Record<string, unknown>;
				if (Array.isArray(content.items)) {
					const textContent = (content.items as Record<string, unknown>[])
						.filter((item) => item.type === 'text')
						.map((item) => item.text as string)
						.join('\n\n');
					return { content: textContent || 'No response text' };
				}
				return { content: extractContentString(result?.content) || 'No response' };
			},
		},
	},

	'enter-plan-mode-tool-use': {
		input: {
			mode: 'hidden',
			label: 'EnterPlanMode',
		},
		result: {
			hidden: true,
		},
	},

	'exit-plan-mode-tool-use': EXIT_PLAN_MODE_RULE,

	'web-search-tool-use': WEB_SEARCH_RULE,

	'web-fetch-tool-use': WEB_FETCH_RULE,

	'write-stdin-tool-use': {
		input: {
			mode: 'hidden',
			label: 'WriteStdin',
		},
		result: {
			hidden: true,
		},
	},

	'update-plan-tool-use': {
		input: {
			mode: 'collapsible',
			label: 'UpdatePlan',
			title: 'Updating plan',
			defaultOpen: false,
			contentKind: 'todoList',
			getContentProps: (input) => ({
				todos: input.todos,
			}),
		},
		result: {
			mode: 'collapsible',
			contentKind: 'successMessage',
			getMessage: () => 'Plan updated',
		},
	},

	'amp-finder-tool-use': {
		input: {
			mode: 'inline',
			label: 'Search',
			getValue: (input) => String(input.query ?? ''),
			action: 'jumpToResult',
			colorScheme: {
				border: 'border-status-neutral-border',
			},
		},
		result: {
			mode: 'collapsible',
			defaultOpen: false,
			contentKind: 'markdown',
			getContentProps: (result) => ({
				content: extractContentString(result?.content),
			}),
		},
	},

	'amp-oracle-tool-use': {
		input: {
			mode: 'collapsible',
			label: 'Oracle',
			title: (input) => `Oracle: ${truncate(String(input.task || 'analyzing'), 80)}`,
			defaultOpen: false,
			contentKind: 'markdown',
			getContentProps: (input) => {
				const parts: string[] = [];
				if (input.task) parts.push(`**Task:** ${input.task}`);
				if (input.context) parts.push(`**Context:** ${input.context}`);
				if (Array.isArray(input.files) && input.files.length > 0) {
					parts.push(`**Files:**\n${(input.files as string[]).map((file) => `- ${file}`).join('\n')}`);
				}
				return { content: parts.join('\n\n') };
			},
		},
		result: {
			mode: 'collapsible',
			defaultOpen: true,
			title: 'Oracle Response',
			contentKind: 'markdown',
			getContentProps: (result) => ({
				content: extractContentString(result?.content),
			}),
		},
	},

	'amp-librarian-tool-use': {
		input: {
			mode: 'collapsible',
			label: 'Librarian',
			title: (input) => `Librarian: ${truncate(String(input.query || 'exploring'), 80)}`,
			defaultOpen: false,
			contentKind: 'markdown',
			getContentProps: (input) => {
				const parts: string[] = [];
				if (input.query) parts.push(`**Query:** ${input.query}`);
				if (input.context) parts.push(`**Context:** ${input.context}`);
				return { content: parts.join('\n\n') };
			},
		},
		result: {
			mode: 'collapsible',
			defaultOpen: true,
			title: 'Librarian Response',
			contentKind: 'markdown',
			getContentProps: (result) => ({
				content: extractContentString(result?.content),
			}),
		},
	},

	'amp-skill-tool-use': {
		input: {
			mode: 'inline',
			label: 'Skill',
			getValue: (input) => String(input.name ?? ''),
			action: 'none',
			colorScheme: {
				border: 'border-status-info-border',
			},
		},
		result: {
			hidden: true,
		},
	},

	'amp-mermaid-tool-use': {
		input: {
			mode: 'inline',
			label: 'Diagram',
			getValue: () => 'rendering',
			action: 'none',
			colorScheme: {
				primary: 'text-muted-foreground',
				border: 'border-status-neutral-border',
			},
		},
		result: {
			hidden: true,
		},
	},

	'amp-handoff-tool-use': {
		input: {
			mode: 'inline',
			label: 'Handoff',
			getValue: (input) => truncate(String(input.goal ?? ''), 60),
			action: 'none',
			colorScheme: {
				primary: 'text-foreground',
				border: 'border-status-info-border',
			},
		},
		result: {
			hidden: true,
		},
	},

	'amp-look-at-tool-use': {
		input: {
			mode: 'inline',
			label: 'Analyze',
			getValue: (input) => String(input.path ?? '').split('/').pop() || String(input.path ?? ''),
			getSecondary: (input) => truncate(String(input.objective ?? ''), 60),
			action: 'none',
			colorScheme: {
				primary: 'text-foreground',
				border: 'border-border',
			},
		},
		result: {
			hidden: true,
		},
	},

	'amp-find-thread-tool-use': {
		input: {
			mode: 'inline',
			label: 'Threads',
			getValue: (input) => truncate(String(input.query ?? ''), 60),
			action: 'none',
			colorScheme: {
				primary: 'text-foreground',
				border: 'border-status-neutral-border',
			},
		},
		result: {
			mode: 'collapsible',
			defaultOpen: false,
			contentKind: 'text',
			getContentProps: (result) => ({
				content: extractContentString(result?.content),
				format: 'plain',
			}),
		},
	},

	'amp-read-thread-tool-use': {
		input: {
			mode: 'inline',
			label: 'Thread',
			getValue: (input) => String(input.threadId ?? 'reading'),
			getSecondary: (input) => truncate(String(input.goal ?? ''), 60),
			action: 'none',
			colorScheme: {
				primary: 'text-foreground',
				border: 'border-status-neutral-border',
			},
		},
		result: {
			mode: 'collapsible',
			defaultOpen: false,
			contentKind: 'markdown',
			getContentProps: (result) => ({
				content: extractContentString(result?.content),
			}),
		},
	},

	'amp-task-list-tool-use': {
		input: {
			mode: 'inline',
			label: 'Tasks',
			getValue: (input) => {
				const action = String(input.action ?? '');
				if (action === 'create') return `creating: ${input.title || 'task'}`;
				if (action === 'update') return `updating #${input.taskId || ''}`;
				if (action === 'get') return `fetching #${input.taskId || ''}`;
				if (action === 'delete') return `deleting #${input.taskId || ''}`;
				return 'listing';
			},
			action: 'none',
			colorScheme: {
				border: 'border-status-info-border',
			},
		},
		result: {
			mode: 'collapsible',
			defaultOpen: false,
			contentKind: 'text',
			getContentProps: (result) => ({
				content: extractContentString(result?.content),
			}),
		},
	},

	'unknown-tool-use': {
		input: {
			mode: 'collapsible',
			label: 'Tool',
			title: 'Parameters',
			defaultOpen: false,
			contentKind: 'text',
			getContentProps: (input) => ({
				content: typeof input === 'string' ? input : JSON.stringify(input, null, 2),
				format: 'code',
			}),
		},
		result: {
			mode: 'collapsible',
			contentKind: 'text',
			getContentProps: (result) => ({
				content: extractContentString(result?.content),
				format: 'plain',
			}),
		},
	},

	default: {
		input: {
			mode: 'collapsible',
			label: 'Tool',
			title: 'Parameters',
			defaultOpen: false,
			contentKind: 'text',
			getContentProps: (input) => ({
				content: typeof input === 'string' ? input : JSON.stringify(input, null, 2),
				format: 'code',
			}),
		},
		result: {
			mode: 'collapsible',
			contentKind: 'text',
			getContentProps: (result) => ({
				content: extractContentString(result?.content),
				format: 'plain',
			}),
		},
	},
};

export function getToolDisplayLabel(toolMessage: ToolUseChatMessage): string {
	if (toolMessage.type === 'unknown-tool-use') {
		return toolMessage.rawName || 'Tool';
	}
	return DISPLAY_NAME_BY_TYPE[toolMessage.type] || fallbackDisplayName(toolMessage.type);
}

export function getToolDisplayDetails(toolMessage: ToolUseChatMessage): Record<string, unknown> {
	return Object.fromEntries(
		Object.entries(toolMessage as unknown as Record<string, unknown>).filter(([key]) =>
			key !== 'timestamp' && key !== 'toolId' && key !== 'type',
		),
	);
}
