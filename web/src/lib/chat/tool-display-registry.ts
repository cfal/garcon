// Registry mapping tool names to their display rules. Each entry
// controls layout mode, content rendering, and action behavior.

import * as m from '$lib/paraglide/messages.js';
import type { TodoItem, TodoStatus } from '$lib/types/chat';
import type { ToolDisplayRule } from './tool-display-contract';
import {
	readRangePresenter,
	webFetchSecondaryPresenter,
	extractContentString,
	fileTitlePresenter,
	diffProps,
} from './tool-display-presenters';

// Coerces a raw tool-result todo array into canonical TodoItem[].
// Tool results bypass converter normalization so this is needed here.
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

const EXIT_PLAN_MODE_RULE: ToolDisplayRule = {
	input: {
		mode: 'collapsible',
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

export const TOOL_DISPLAY_REGISTRY: Record<string, ToolDisplayRule> = {
	Bash: {
		input: {
			mode: 'inline',
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

	Read: {
		input: {
			mode: 'inline',
			label: 'Read',
			getValue: (input) => String(input.file_path ?? ''),
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

	Edit: {
		input: {
			mode: 'collapsible',
			title: (input) => {
				const fp = input.file_path as string | undefined;
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
					? (input.changes as Array<{ path?: unknown; kind?: unknown }>)
					: [];
				if (!input.file_path && !input.old_string && !input.new_string && changes.length > 0) {
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

	Write: {
		input: {
			mode: 'collapsible',
			title: fileTitlePresenter,
			defaultOpen: false,
			contentKind: 'diff',
			actionButton: 'none',
			getContentProps: (input) => ({
				oldContent: '',
				newContent: input.content,
				filePath: input.file_path,
				badge: 'New',
				badgeColor: 'green',
			}),
		},
		result: {
			hideOnSuccess: true,
		},
	},

	ApplyPatch: {
		input: {
			mode: 'collapsible',
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

	Grep: {
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

	Glob: {
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

	TodoWrite: {
		input: {
			mode: 'collapsible',
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

	TodoRead: {
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

	TaskCreate: {
		input: {
			mode: 'inline',
			label: 'Task',
			getValue: (input) => String(input.subject ?? 'Creating task'),
			getSecondary: (input) => (input.status as string) || undefined,
			action: 'none',
			colorScheme: {
				primary: 'text-foreground',
				border: 'border-status-info-border',
			},
		},
		result: {
			hideOnSuccess: true,
		},
	},

	TaskUpdate: {
		input: {
			mode: 'inline',
			label: 'Task',
			getValue: (input) => {
				const parts: string[] = [];
				if (input.taskId) parts.push(`#${input.taskId}`);
				if (input.status) parts.push(input.status as string);
				if (input.subject) parts.push(`"${input.subject}"`);
				return parts.join(' -> ') || 'updating';
			},
			action: 'none',
			colorScheme: {
				primary: 'text-foreground',
				border: 'border-status-info-border',
			},
		},
		result: {
			hideOnSuccess: true,
		},
	},

	TaskList: {
		input: {
			mode: 'inline',
			label: 'Tasks',
			getValue: () => 'listing tasks',
			action: 'none',
			colorScheme: {
				primary: 'text-muted-foreground',
				border: 'border-status-info-border',
			},
		},
		result: {
			mode: 'collapsible',
			defaultOpen: true,
			title: 'Task list',
			contentKind: 'task',
			getContentProps: (result) => ({
				content: extractContentString(result?.content),
			}),
		},
	},

	TaskGet: {
		input: {
			mode: 'inline',
			label: 'Task',
			getValue: (input) => (input.taskId ? `#${input.taskId}` : 'fetching'),
			action: 'none',
			colorScheme: {
				primary: 'text-foreground',
				border: 'border-status-info-border',
			},
		},
		result: {
			mode: 'collapsible',
			defaultOpen: true,
			title: 'Task details',
			contentKind: 'task',
			getContentProps: (result) => ({
				content: extractContentString(result?.content),
			}),
		},
	},

	Task: {
		input: {
			mode: 'collapsible',
			title: (input) => {
				const subagentType = input.subagent_type || 'Agent';
				const description = input.description || 'Running task';
				return `Subagent / ${subagentType}: ${description}`;
			},
			defaultOpen: true,
			contentKind: 'markdown',
			getContentProps: (input) => {
				const hasOnlyPrompt = input.prompt && !input.model && !input.resume;
				if (hasOnlyPrompt) {
					return { content: input.prompt || '' };
				}
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

	exit_plan_mode: EXIT_PLAN_MODE_RULE,
	ExitPlanMode: EXIT_PLAN_MODE_RULE,

	WebSearch: WEB_SEARCH_RULE,

	WebFetch: WEB_FETCH_RULE,

	WriteStdin: {
		input: {
			mode: 'hidden',
		},
		result: {
			hidden: true,
		},
	},

	UpdatePlan: {
		input: {
			mode: 'collapsible',
			title: 'Updating plan',
			defaultOpen: false,
			contentKind: 'todoList',
			getContentProps: (input) => ({
				todos: input.items || input.todos,
			}),
		},
		result: {
			mode: 'collapsible',
			contentKind: 'successMessage',
			getMessage: () => 'Plan updated',
		},
	},

	finder: {
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
				format: 'plain',
			}),
		},
	},

	oracle: {
		input: {
			mode: 'collapsible',
			title: (input) => `Oracle: ${truncate(String(input.task || 'analyzing'), 80)}`,
			defaultOpen: false,
			contentKind: 'markdown',
			getContentProps: (input) => {
				const parts: string[] = [];
				if (input.task) parts.push(`**Task:** ${input.task}`);
				if (input.context) parts.push(`**Context:** ${input.context}`);
				if (Array.isArray(input.files) && input.files.length > 0)
					parts.push(`**Files:**\n${(input.files as string[]).map((f) => `- ${f}`).join('\n')}`);
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

	librarian: {
		input: {
			mode: 'collapsible',
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

	skill: {
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

	mermaid: {
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

	handoff: {
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

	look_at: {
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

	read_web_page: WEB_FETCH_RULE,

	web_search: WEB_SEARCH_RULE,

	find_thread: {
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

	read_thread: {
		input: {
			mode: 'inline',
			label: 'Thread',
			getValue: (input) => String(input.threadID ?? 'reading'),
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

	task_list: {
		input: {
			mode: 'inline',
			label: 'Tasks',
			getValue: (input) => {
				const action = String(input.action ?? '');
				if (action === 'create') return `creating: ${input.title || 'task'}`;
				if (action === 'update') return `updating #${input.taskID || ''}`;
				if (action === 'get') return `fetching #${input.taskID || ''}`;
				if (action === 'delete') return `deleting #${input.taskID || ''}`;
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

	Default: {
		input: {
			mode: 'collapsible',
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
