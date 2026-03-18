// Bridges typed ToolUseMessage subclasses into the {name, input}
// format consumed by the config-driven tool renderer registry.

import type { ToolUseChatMessage } from '$shared/chat-types';

export interface RenderToolPayload {
	name: string;
	input: Record<string, unknown>;
}

function optionalField<T>(key: string, value: T | undefined): Record<string, T> {
	return value !== undefined ? { [key]: value } : {};
}

export function toRenderToolPayload(message: ToolUseChatMessage): RenderToolPayload {
	switch (message.type) {
		case 'bash-tool-use':
			return {
				name: 'Bash',
				input: { command: message.command, ...optionalField('description', message.description) },
			};

		case 'read-tool-use':
			return {
				name: 'Read',
				input: {
					file_path: message.filePath,
					...optionalField('offset', message.offset),
					...optionalField('limit', message.limit),
					...optionalField('end_line', message.endLine),
				},
			};

		case 'edit-tool-use':
			return {
				name: 'Edit',
				input: {
					...optionalField('file_path', message.filePath),
					...optionalField('old_string', message.oldString),
					...optionalField('new_string', message.newString),
					...optionalField('changes', message.changes),
				},
			};

		case 'write-tool-use':
			return {
				name: 'Write',
				input: { file_path: message.filePath, ...optionalField('content', message.content) },
			};

		case 'apply-patch-tool-use':
			return {
				name: 'ApplyPatch',
				input: {
					...optionalField('file_path', message.filePath),
					...optionalField('old_string', message.oldString),
					...optionalField('new_string', message.newString),
				},
			};

		case 'grep-tool-use':
			return {
				name: 'Grep',
				input: {
					...optionalField('pattern', message.pattern),
					...optionalField('path', message.path),
				},
			};

		case 'glob-tool-use':
			return {
				name: 'Glob',
				input: {
					...optionalField('pattern', message.pattern),
					...optionalField('path', message.path),
				},
			};

		case 'web-search-tool-use':
			return { name: 'WebSearch', input: { query: message.query } };

		case 'web-fetch-tool-use':
			return {
				name: 'WebFetch',
				input: { url: message.url, ...optionalField('prompt', message.prompt) },
			};

		case 'todo-write-tool-use':
			return { name: 'TodoWrite', input: { todos: message.todos } };

		case 'todo-read-tool-use':
			return { name: 'TodoRead', input: {} };

		case 'task-tool-use':
			return {
				name: 'Task',
				input: {
					...optionalField('subagent_type', message.subagentType),
					...optionalField('description', message.description),
					...optionalField('prompt', message.prompt),
					...optionalField('model', message.model),
					...optionalField('resume', message.resume),
				},
			};

		case 'update-plan-tool-use':
			return { name: 'UpdatePlan', input: { todos: message.todos } };

		case 'write-stdin-tool-use':
			return { name: 'WriteStdin', input: message.input };

		case 'enter-plan-mode-tool-use':
			return { name: 'EnterPlanMode', input: {} };

		case 'exit-plan-mode-tool-use':
			return {
				name: 'ExitPlanMode',
				input: { plan: message.plan, ...optionalField('allowedPrompts', message.allowedPrompts) },
			};

		case 'unknown-tool-use':
			return { name: message.rawName || 'Unknown', input: message.input };
	}
}
