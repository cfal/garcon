import * as m from '$lib/paraglide/messages.js';
import type { ToolDisplayRule } from './tool-display-contract.js';
import { extractContentString, truncate } from './tool-display-presenters.js';

export const AMP_TOOL_DISPLAY_RULES = {
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
			title: () => m.chat_tool_oracle_response(),
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
			title: () => m.chat_tool_librarian_response(),
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
} satisfies Record<string, ToolDisplayRule>;
