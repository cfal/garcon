import {
	CodexSubagentToolUseMessage,
	ToolResultMessage,
	type ChatMessage,
	type CodexSubagentAction,
	type CodexSubagentDetails,
} from '$shared/chat-types';

export type SubagentManagementStatus =
	| 'idle'
	| 'running'
	| 'waiting'
	| 'interrupted'
	| 'closed'
	| 'error'
	| 'observing';

export interface SubagentManagementEntry {
	id: string;
	kind: 'root' | 'subagent';
	name: string;
	status: SubagentManagementStatus;
	statusLabel: string;
	model?: string;
	path?: string;
	message?: string;
	lastActionLabel?: string;
	anchorId?: string;
}

export interface SubagentManagementModel {
	entries: SubagentManagementEntry[];
	subagents: SubagentManagementEntry[];
}

export interface BuildSubagentManagementOptions {
	rootTitle?: string;
	rootModel?: string | null;
	rootStatus?: 'idle' | 'running';
}

export function buildSubagentManagementModel(
	messages: ChatMessage[],
	options: BuildSubagentManagementOptions = {},
): SubagentManagementModel {
	const resultsByToolId = new Map<string, ToolResultMessage>();
	for (const message of messages) {
		if (message instanceof ToolResultMessage) {
			resultsByToolId.set(message.toolId, message);
		}
	}

	const rootStatus = options.rootStatus ?? 'idle';
	const rootEntry: SubagentManagementEntry = {
		id: 'root',
		kind: 'root',
		name: options.rootTitle || 'Root',
		model: options.rootModel ?? undefined,
		status: rootStatus,
		statusLabel: statusLabelFor(rootStatus),
	};

	const orderedSubagents: SubagentManagementEntry[] = [];
	const subagentsByKey = new Map<string, SubagentManagementEntry>();
	const aliasToKey = new Map<string, string>();

	for (const message of messages) {
		if (!(message instanceof CodexSubagentToolUseMessage)) continue;

		const result = resultsByToolId.get(message.toolId);
		const key = resolveEntryKey(message.details, message.toolId, aliasToKey);
		let entry = subagentsByKey.get(key);
		if (!entry) {
			entry = createSubagentEntry(key, message);
			subagentsByKey.set(key, entry);
			orderedSubagents.push(entry);
		}

		registerAliases(key, message.details, aliasToKey);
		applySubagentEvent(entry, message, result);
	}

	return {
		entries: [rootEntry, ...orderedSubagents],
		subagents: orderedSubagents,
	};
}

function createSubagentEntry(
	key: string,
	message: CodexSubagentToolUseMessage,
): SubagentManagementEntry {
	return {
		id: key,
		kind: 'subagent',
		name: displayNameFor(message.details, message.toolId),
		path: message.details.target ?? message.details.pathPrefix ?? message.details.taskName,
		model: message.details.model,
		message: message.details.message,
		status: 'running',
		statusLabel: statusLabelFor('running'),
		lastActionLabel: actionLabelFor(message.action),
		anchorId: `tool-input-${message.toolId}`,
	};
}

function applySubagentEvent(
	entry: SubagentManagementEntry,
	message: CodexSubagentToolUseMessage,
	result: ToolResultMessage | undefined,
): void {
	entry.name = displayNameFor(message.details, entry.name);
	entry.path = message.details.target ?? message.details.pathPrefix ?? entry.path;
	entry.model = message.details.model ?? entry.model;
	entry.message = message.details.message ?? entry.message;
	entry.lastActionLabel = actionLabelFor(message.action);
	entry.status = statusFor(message.action, result?.isError === true);
	entry.statusLabel = statusLabelFor(entry.status);
}

function resolveEntryKey(
	details: CodexSubagentDetails,
	fallback: string,
	aliasToKey: Map<string, string>,
): string {
	const candidates = [
		details.target,
		details.pathPrefix,
		details.taskName ? `/root/${details.taskName}` : undefined,
		details.taskName,
	];
	for (const candidate of candidates) {
		if (!candidate) continue;
		const alias = normalizeAlias(candidate);
		const existing = aliasToKey.get(alias);
		if (existing) return existing;
	}

	return normalizeAlias(details.target ?? details.pathPrefix ?? details.taskName ?? fallback);
}

function registerAliases(
	key: string,
	details: CodexSubagentDetails,
	aliasToKey: Map<string, string>,
): void {
	const aliases = [
		details.target,
		details.pathPrefix,
		details.taskName,
		details.taskName ? `/root/${details.taskName}` : undefined,
	];
	for (const alias of aliases) {
		if (alias) aliasToKey.set(normalizeAlias(alias), key);
	}
}

function normalizeAlias(value: string): string {
	return value.trim().replace(/\/+$/, '') || value;
}

function displayNameFor(details: CodexSubagentDetails, fallback: string): string {
	if (details.taskName) return details.taskName;
	if (details.target) return details.target.split('/').filter(Boolean).at(-1) ?? details.target;
	if (details.pathPrefix)
		return details.pathPrefix.split('/').filter(Boolean).at(-1) ?? details.pathPrefix;
	return fallback;
}

function actionLabelFor(action: CodexSubagentAction): string {
	switch (action) {
		case 'spawn_agent':
			return 'Spawned';
		case 'send_input':
		case 'send_message':
			return 'Messaged';
		case 'followup_task':
			return 'Follow-up';
		case 'wait_agent':
			return 'Waiting';
		case 'interrupt_agent':
			return 'Interrupted';
		case 'list_agents':
			return 'Listed';
		case 'close_agent':
			return 'Closed';
		case 'resume_agent':
			return 'Resumed';
	}
}

function statusFor(action: CodexSubagentAction, isError: boolean): SubagentManagementStatus {
	if (isError) return 'error';
	switch (action) {
		case 'close_agent':
			return 'closed';
		case 'interrupt_agent':
			return 'interrupted';
		case 'wait_agent':
			return 'waiting';
		case 'list_agents':
			return 'observing';
		case 'spawn_agent':
		case 'send_input':
		case 'send_message':
		case 'followup_task':
		case 'resume_agent':
			return 'running';
	}
}

function statusLabelFor(status: SubagentManagementStatus): string {
	switch (status) {
		case 'idle':
			return 'Idle';
		case 'running':
			return 'Running';
		case 'waiting':
			return 'Waiting';
		case 'interrupted':
			return 'Interrupted';
		case 'closed':
			return 'Closed';
		case 'error':
			return 'Error';
		case 'observing':
			return 'Observed';
	}
}
