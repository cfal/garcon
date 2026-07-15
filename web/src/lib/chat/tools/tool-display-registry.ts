// Registry mapping explicit tool-use message types to display rules.
// Known provider-specific tools must arrive here as typed messages.

import { coerceTodoItems, type ToolUseChatMessage } from '$shared/chat-types';
import * as m from '$lib/paraglide/messages.js';
import type { ToolDisplayRule } from '$lib/chat/tools/tool-display-contract.js';
import {
	diffProps,
	extractContentString,
	fileTitlePresenter,
	readRangePresenter,
	webFetchSecondaryPresenter,
} from '$lib/chat/tools/tool-display-presenters.js';

type ToolDisplayRegistry = Record<string, ToolDisplayRule>;

const truncate = (s: string, n: number) => (s.length > n ? s.slice(0, n) + '...' : s);

function filesFoundTitle(count: number): string {
	return count === 1 ? m.chat_tool_file_found() : m.chat_tool_files_found({ count });
}

function matchesFoundTitle(count: number): string {
	return count === 1 ? m.chat_tool_match_found() : m.chat_tool_matches_found({ count });
}

function asFiniteNumber(value: unknown): number | undefined {
	if (typeof value === 'number' && Number.isFinite(value)) return value;
	if (typeof value === 'string') {
		const parsed = Number(value);
		if (Number.isFinite(parsed)) return parsed;
	}
	return undefined;
}

const DISPLAY_NAME_BY_TYPE: Record<string, string> = {
	'bash-tool-use': 'Bash',
	'exec-tool-use': 'Exec',
	'wait-tool-use': 'Wait',
	'read-tool-use': 'Read',
	'list-tool-use': 'List',
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
	'codex-subagent-tool-use': 'Subagent',
	'update-plan-tool-use': 'UpdatePlan',
	'write-stdin-tool-use': 'WriteStdin',
	'enter-plan-mode-tool-use': 'EnterPlanMode',
	'exit-plan-mode-tool-use': 'ExitPlanMode',
	'ask-user-question-tool-use': 'Question',
	'cursor-ask-question-tool-use': 'Question',
	'cursor-create-plan-tool-use': 'Plan',
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
	'external-tool-use': 'Tool',
	'mcp-tool-use': 'MCP',
	'request-permissions-tool-use': 'Permissions',
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
		label: m.chat_tool_implementation_plan(),
		title: m.chat_tool_implementation_plan(),
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

function appendDetailLine(lines: string[], label: string, value: string | undefined): void {
	if (!value) return;
	lines.push(
		value.includes('\n') || value.startsWith('- ')
			? `**${label}:**\n${value}`
			: `**${label}:** ${value}`,
	);
}

function codexSubagentActionLabel(action: string): string {
	switch (action) {
		case 'spawn_agent':
			return 'Spawn agent';
		case 'send_input':
		case 'send_message':
			return 'Send message';
		case 'followup_task':
			return 'Follow-up task';
		case 'wait_agent':
			return 'Wait for agent';
		case 'interrupt_agent':
			return 'Interrupt agent';
		case 'list_agents':
			return 'List agents';
		case 'close_agent':
			return 'Close agent';
		case 'resume_agent':
			return 'Resume agent';
		default:
			return 'Subagent';
	}
}

function codexSubagentDetails(input: Record<string, unknown>): Record<string, unknown> {
	return input.details && typeof input.details === 'object' && !Array.isArray(input.details)
		? (input.details as Record<string, unknown>)
		: {};
}

function codexSubagentTitle(input: Record<string, unknown>): string {
	const action = String(input.action ?? '');
	const details = codexSubagentDetails(input);
	const label = codexSubagentActionLabel(action);
	const primary = String(details.taskName ?? details.message ?? details.target ?? '').trim();
	return primary ? `${label}: ${truncate(primary, 80)}` : label;
}

function codexSubagentItemsMarkdown(value: unknown): string | undefined {
	if (!Array.isArray(value)) return undefined;
	const lines = value
		.map((item) => {
			if (!item || typeof item !== 'object') return '';
			const raw = item as Record<string, unknown>;
			return String(raw.text ?? raw.path ?? raw.name ?? raw.type ?? '').trim();
		})
		.filter(Boolean)
		.map((item) => `- ${item}`);
	return lines.length > 0 ? lines.join('\n') : undefined;
}

function codexSubagentMarkdown(input: Record<string, unknown>): string {
	const action = String(input.action ?? '');
	const details = codexSubagentDetails(input);
	const lines: string[] = [];
	appendDetailLine(lines, 'Action', codexSubagentActionLabel(action));
	appendDetailLine(lines, 'Task', details.taskName as string | undefined);
	appendDetailLine(lines, 'Target', details.target as string | undefined);
	appendDetailLine(
		lines,
		'Targets',
		Array.isArray(details.targets) ? details.targets.filter(Boolean).join(', ') : undefined,
	);
	appendDetailLine(lines, 'Message', details.message as string | undefined);
	appendDetailLine(lines, 'Agent type', details.agentType as string | undefined);
	appendDetailLine(lines, 'Model', details.model as string | undefined);
	appendDetailLine(lines, 'Reasoning', details.reasoningEffort as string | undefined);
	appendDetailLine(lines, 'Service tier', details.serviceTier as string | undefined);
	appendDetailLine(lines, 'Fork turns', details.forkTurns as string | undefined);
	appendDetailLine(
		lines,
		'Timeout',
		typeof details.timeoutMs === 'number' ? `${details.timeoutMs} ms` : undefined,
	);
	appendDetailLine(lines, 'Path prefix', details.pathPrefix as string | undefined);
	appendDetailLine(lines, 'Items', codexSubagentItemsMarkdown(details.items));
	return lines.join('\n\n');
}

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
			language: 'bash',
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

	'exec-tool-use': {
		input: {
			mode: 'inline',
			getLabel: (input) => {
				const language = String(input.language ?? '').trim();
				return language ? `Exec ${language}` : 'Exec';
			},
			getValue: (input) => String(input.code ?? ''),
			getLanguage: (input) => String(input.language ?? ''),
			action: 'copyValue',
			style: 'terminal',
			wrapText: true,
		},
		result: {
			mode: 'special',
		},
	},

	'wait-tool-use': {
		input: {
			mode: 'hidden',
			label: 'Wait',
		},
		result: {
			hidden: true,
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

	'list-tool-use': {
		input: {
			mode: 'inline',
			label: 'List',
			getValue: (input) => String(input.path ?? m.chat_tool_current_directory()),
			action: 'none',
			colorScheme: {
				primary: 'text-foreground',
				background: '',
				border: 'border-border',
			},
		},
		result: {
			hideOnSuccess: true,
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
					return m.chat_tool_files_count({ count: changes.length });
				}
				return fp?.split('/').pop() || fp || m.chat_tool_file();
			},
			defaultOpen: false,
			contentKind: 'diff',
			actionButton: 'none',
			getContentProps: (input) => {
				const changes = Array.isArray(input.changes)
					? (input.changes as Array<{ path?: unknown }>)
					: [];
				if (!input.filePath && !input.oldString && !input.newString && changes.length > 0) {
					const files = changes.map((change) => String(change?.path ?? '').trim()).filter(Boolean);
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
				badge: m.chat_tool_badge_new(),
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
			getContentProps: (input) => {
				const patch = typeof input.patch === 'string' ? input.patch : '';
				if (patch && !input.oldString && !input.newString) {
					return {
						oldContent: '',
						newContent: patch,
						filePath: input.filePath,
						showHeader: false,
						badge: m.chat_tool_badge_patch(),
						badgeColor: 'gray',
					};
				}
				return diffProps(input, m.chat_tool_badge_patch(), 'gray');
			},
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
				if (!rawPath) return m.chat_tool_project_files();
				return rawPath.split(/[\\/]/).pop() || rawPath;
			},
			getSecondary: (input) => {
				const pattern = String(input.pattern ?? '').trim();
				return pattern ? m.chat_tool_pattern({ pattern }) : undefined;
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
				const matchCount = asFiniteNumber(toolData.totalMatches);
				if (matchCount !== undefined) return matchesFoundTitle(matchCount);
				const count =
					(toolData.numFiles as number) ||
					(toolData.filenames as unknown[] | undefined)?.length ||
					0;
				return filesFoundTitle(count);
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
				return filesFoundTitle(count);
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
			title: m.chat_tool_updating_todo_list(),
			defaultOpen: true,
			contentKind: 'todoList',
			getContentProps: (input) => ({
				todos: input.todos,
			}),
		},
		result: {
			mode: 'collapsible',
			contentKind: 'successMessage',
			getMessage: () => m.chat_tool_todo_list_updated(),
		},
	},

	'todo-read-tool-use': {
		input: {
			mode: 'inline',
			label: 'TodoRead',
			getValue: () => m.chat_tool_reading_list(),
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
				const todos = coerceTodoItems(content.items || content.todos);
				return { todos, isResult: true };
			},
		},
	},

	'task-tool-use': {
		input: {
			mode: 'collapsible',
			label: 'Task',
			title: (input) => {
				const agent = String(input.subagentType || m.chat_tool_agent());
				const description = String(input.description || m.chat_tool_running_task());
				return m.chat_tool_subagent_title({ agent, description });
			},
			defaultOpen: true,
			contentKind: 'markdown',
			getContentProps: (input) => {
				const hasOnlyPrompt = input.prompt && !input.model && !input.resume;
				if (hasOnlyPrompt) return { content: input.prompt || '' };
				const parts: string[] = [];
				if (input.model) parts.push(m.chat_tool_task_model({ model: String(input.model) }));
				if (input.prompt) parts.push(m.chat_tool_task_prompt({ prompt: String(input.prompt) }));
				if (input.resume) parts.push(m.chat_tool_task_resume({ resume: String(input.resume) }));
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
				return Array.isArray(content.items)
					? m.chat_tool_subagent_response()
					: m.chat_tool_subagent_result();
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
					return { content: textContent || m.chat_tool_no_response_text() };
				}
				return { content: extractContentString(result?.content) || m.chat_tool_no_response() };
			},
		},
	},

	'codex-subagent-tool-use': {
		input: {
			mode: 'collapsible',
			label: 'Subagent',
			title: codexSubagentTitle,
			defaultOpen: true,
			contentKind: 'markdown',
			getContentProps: (input) => ({
				content: codexSubagentMarkdown(input),
			}),
			colorScheme: {
				border: 'border-status-info-border',
			},
		},
		result: {
			mode: 'collapsible',
			title: 'Subagent result',
			defaultOpen: true,
			contentKind: 'markdown',
			getContentProps: (result) => ({
				content: extractContentString(result?.content) || m.chat_tool_no_response(),
			}),
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

	'cursor-ask-question-tool-use': {
		input: {
			mode: 'hidden',
			label: 'Question',
		},
		result: {
			hidden: true,
		},
	},

	'ask-user-question-tool-use': {
		input: {
			mode: 'hidden',
			label: 'Question',
		},
		result: {
			hidden: true,
		},
	},

	'cursor-create-plan-tool-use': {
		input: {
			mode: 'hidden',
			label: 'Plan',
		},
		result: {
			hidden: true,
		},
	},

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
			title: m.chat_tool_updating_plan(),
			defaultOpen: false,
			contentKind: 'todoList',
			getContentProps: (input) => ({
				todos: input.todos,
			}),
		},
		result: {
			mode: 'collapsible',
			contentKind: 'successMessage',
			getMessage: () => m.chat_tool_plan_updated(),
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
			title: (input) =>
				m.chat_tool_oracle_title({
					task: truncate(String(input.task || m.chat_tool_analyzing()), 80),
				}),
			defaultOpen: false,
			contentKind: 'markdown',
			getContentProps: (input) => {
				const parts: string[] = [];
				if (input.task) parts.push(m.chat_tool_field_task({ task: String(input.task) }));
				if (input.context) {
					parts.push(m.chat_tool_field_context({ context: String(input.context) }));
				}
				if (Array.isArray(input.files) && input.files.length > 0) {
					parts.push(
						m.chat_tool_field_files({
							files: (input.files as string[]).map((file) => `- ${file}`).join('\n'),
						}),
					);
				}
				return { content: parts.join('\n\n') };
			},
		},
		result: {
			mode: 'collapsible',
			defaultOpen: true,
			title: m.chat_tool_oracle_response(),
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
			title: (input) =>
				m.chat_tool_librarian_title({
					query: truncate(String(input.query || m.chat_tool_exploring()), 80),
				}),
			defaultOpen: false,
			contentKind: 'markdown',
			getContentProps: (input) => {
				const parts: string[] = [];
				if (input.query) parts.push(m.chat_tool_field_query({ query: String(input.query) }));
				if (input.context) {
					parts.push(m.chat_tool_field_context({ context: String(input.context) }));
				}
				return { content: parts.join('\n\n') };
			},
		},
		result: {
			mode: 'collapsible',
			defaultOpen: true,
			title: m.chat_tool_librarian_response(),
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
			getValue: () => m.chat_tool_rendering(),
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
			getValue: (input) =>
				String(input.path ?? '')
					.split('/')
					.pop() || String(input.path ?? ''),
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
				if (action === 'create') {
					return m.chat_tool_task_creating({ title: String(input.title || m.chat_tool_task()) });
				}
				if (action === 'update') {
					return m.chat_tool_task_updating({ taskId: String(input.taskId || '') });
				}
				if (action === 'get') {
					return m.chat_tool_task_fetching({ taskId: String(input.taskId || '') });
				}
				if (action === 'delete') {
					return m.chat_tool_task_deleting({ taskId: String(input.taskId || '') });
				}
				return m.chat_tool_task_listing();
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

	'external-tool-use': {
		input: {
			mode: 'collapsible',
			label: 'Tool',
			title: m.chat_tool_parameters(),
			defaultOpen: false,
			contentKind: 'text',
			getContentProps: (input) => ({
				content: JSON.stringify(input, null, 2),
				format: 'code',
			}),
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

	'mcp-tool-use': {
		input: {
			mode: 'collapsible',
			label: 'MCP',
			title: m.chat_tool_parameters(),
			defaultOpen: false,
			contentKind: 'text',
			getContentProps: (input) => ({
				content: JSON.stringify(input, null, 2),
				format: 'code',
			}),
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

	'request-permissions-tool-use': {
		input: {
			mode: 'collapsible',
			label: 'Permissions',
			title: m.chat_tool_requested_permissions(),
			defaultOpen: true,
			contentKind: 'text',
			getContentProps: (input) => ({
				content: JSON.stringify(input, null, 2),
				format: 'code',
			}),
		},
		result: {
			hidden: true,
		},
	},

	'unknown-tool-use': {
		input: {
			mode: 'collapsible',
			label: 'Tool',
			title: m.chat_tool_parameters(),
			defaultOpen: false,
			contentKind: 'text',
			getContentProps: (input) => ({
				content: typeof input === 'string' ? input : JSON.stringify(input, null, 2),
				format: 'code',
				language: 'json',
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
			title: m.chat_tool_parameters(),
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
	if (toolMessage.type === 'external-tool-use') {
		return toolMessage.namespace
			? `${toolMessage.namespace}.${toolMessage.name}`
			: toolMessage.name;
	}
	if (toolMessage.type === 'mcp-tool-use') {
		return `${toolMessage.server}.${toolMessage.tool}`;
	}
	return DISPLAY_NAME_BY_TYPE[toolMessage.type] || fallbackDisplayName(toolMessage.type);
}

export function getToolDisplayDetails(toolMessage: ToolUseChatMessage): Record<string, unknown> {
	return Object.fromEntries(
		Object.entries(toolMessage as unknown as Record<string, unknown>).filter(
			([key]) => key !== 'timestamp' && key !== 'toolId' && key !== 'type',
		),
	);
}
