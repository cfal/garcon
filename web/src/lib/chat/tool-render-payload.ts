// Bridges typed ToolUseMessage subclasses into the {name, input}
// format consumed by the config-driven tool renderer registry.

import {
	ToolUseMessage,
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
} from '$shared/chat-types';

export interface RenderToolPayload {
	name: string;
	input: Record<string, unknown>;
}

function optionalField<T>(key: string, value: T | undefined): Record<string, T> {
	return value !== undefined ? { [key]: value } : {};
}

export function toRenderToolPayload(message: ToolUseMessage): RenderToolPayload {
	if (message instanceof BashToolUseMessage) {
		return {
			name: 'Bash',
			input: { command: message.command, ...optionalField('description', message.description) },
		};
	}

	if (message instanceof ReadToolUseMessage) {
		return {
			name: 'Read',
			input: {
				file_path: message.filePath,
				...optionalField('offset', message.offset),
				...optionalField('limit', message.limit),
				...optionalField('end_line', message.endLine),
			},
		};
	}

	if (message instanceof EditToolUseMessage) {
		return {
			name: 'Edit',
			input: {
				...optionalField('file_path', message.filePath),
				...optionalField('old_string', message.oldString),
				...optionalField('new_string', message.newString),
				...optionalField('changes', message.changes),
			},
		};
	}

	if (message instanceof WriteToolUseMessage) {
		return {
			name: 'Write',
			input: { file_path: message.filePath, ...optionalField('content', message.content) },
		};
	}

	if (message instanceof ApplyPatchToolUseMessage) {
		return {
			name: 'ApplyPatch',
			input: {
				...optionalField('file_path', message.filePath),
				...optionalField('old_string', message.oldString),
				...optionalField('new_string', message.newString),
			},
		};
	}

	if (message instanceof GrepToolUseMessage) {
		return {
			name: 'Grep',
			input: {
				...optionalField('pattern', message.pattern),
				...optionalField('path', message.path),
			},
		};
	}

	if (message instanceof GlobToolUseMessage) {
		return {
			name: 'Glob',
			input: {
				...optionalField('pattern', message.pattern),
				...optionalField('path', message.path),
			},
		};
	}

	if (message instanceof WebSearchToolUseMessage) {
		return { name: 'WebSearch', input: { query: message.query } };
	}

	if (message instanceof WebFetchToolUseMessage) {
		return {
			name: 'WebFetch',
			input: { url: message.url, ...optionalField('prompt', message.prompt) },
		};
	}

	if (message instanceof TodoWriteToolUseMessage) {
		return { name: 'TodoWrite', input: { todos: message.todos } };
	}

	if (message instanceof TodoReadToolUseMessage) {
		return { name: 'TodoRead', input: {} };
	}

	if (message instanceof TaskToolUseMessage) {
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
	}

	if (message instanceof UpdatePlanToolUseMessage) {
		return { name: 'UpdatePlan', input: { todos: message.todos } };
	}

	if (message instanceof WriteStdinToolUseMessage) {
		return { name: 'WriteStdin', input: message.input };
	}

	if (message instanceof EnterPlanModeToolUseMessage) {
		return { name: 'EnterPlanMode', input: {} };
	}

	if (message instanceof ExitPlanModeToolUseMessage) {
		return {
			name: 'ExitPlanMode',
			input: { plan: message.plan, ...optionalField('allowedPrompts', message.allowedPrompts) },
		};
	}

	if (message instanceof UnknownToolUseMessage) {
		return { name: message.rawName || 'Unknown', input: message.input };
	}

	return { name: message.rawName || 'Unknown', input: {} };
}
