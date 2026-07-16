import {
	CodexSubagentToolUseMessage,
	ToolResultMessage,
	type ChatMessage,
	type CodexSubagentAction,
	type CodexSubagentDetails,
	type CodexSubagentState,
} from '$shared/chat-types';

export type SubagentManagementStatus =
	| 'idle'
	| 'running'
	| 'waiting'
	| 'interrupted'
	| 'completed'
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
		for (const eventDetails of entryDetailsForMessage(message)) {
			const key = resolveEntryKey(eventDetails, message.toolId, aliasToKey, message.action);
			if (!key) continue;

			let entry = subagentsByKey.get(key);
			if (!entry) {
				entry = createSubagentEntry(key, message, eventDetails);
				subagentsByKey.set(key, entry);
				orderedSubagents.push(entry);
			}

			registerAliases(key, eventDetails, aliasToKey);
			applySubagentEvent(entry, message, result, eventDetails);
		}
	}

	return {
		entries: [rootEntry, ...orderedSubagents],
		subagents: orderedSubagents,
	};
}

function createSubagentEntry(
	key: string,
	message: CodexSubagentToolUseMessage,
	details: CodexSubagentDetails,
): SubagentManagementEntry {
	return {
		id: key,
		kind: 'subagent',
		name: displayNameFor(details, message.toolId),
		path: details.target ?? details.pathPrefix ?? details.taskName,
		model: details.model,
		message: details.message,
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
	details: CodexSubagentDetails,
): void {
	entry.name = displayNameFor(details, entry.name);
	entry.path = details.target ?? details.pathPrefix ?? entry.path;
	entry.model = details.model ?? entry.model;
	entry.lastActionLabel = actionLabelFor(message.action);
	const agentState = stateForDetails(details);
	entry.message = agentState?.message ?? details.message ?? entry.message;
	entry.status = statusFor(message.action, result?.isError === true, agentState);
	entry.statusLabel = agentState ? statusLabelForAgentState(agentState) : statusLabelFor(entry.status);
}

function entryDetailsForMessage(message: CodexSubagentToolUseMessage): CodexSubagentDetails[] {
	if (message.action === 'list_agents') return [];
	const targets = message.details.targets?.filter((target) => target.trim().length > 0)
		?? Object.keys(message.details.agentStates ?? {});
	if (targets.length === 0) return [message.details];
	return targets.map((target) => ({
		...message.details,
		target,
		targets: undefined,
	}));
}

function resolveEntryKey(
	details: CodexSubagentDetails,
	fallback: string,
	aliasToKey: Map<string, string>,
	action: CodexSubagentAction,
): string | null {
	const candidates = [
		details.target,
		details.threadId,
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

	const identity = details.target ?? details.pathPrefix ?? details.taskName;
	if (identity) return normalizeAlias(identity);
	if (action === 'spawn_agent') return normalizeAlias(fallback);
	return null;
}

function registerAliases(
	key: string,
	details: CodexSubagentDetails,
	aliasToKey: Map<string, string>,
): void {
	const aliases = [
		details.target,
		details.threadId,
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
		case 'agent_status':
			return 'Status';
	}
}

function stateForDetails(details: CodexSubagentDetails): CodexSubagentState | undefined {
	return details.target ? details.agentStates?.[details.target] : undefined;
}

function statusFor(
	action: CodexSubagentAction,
	isError: boolean,
	agentState?: CodexSubagentState,
): SubagentManagementStatus {
	if (agentState) {
		switch (agentState.status) {
			case 'pendingInit':
			case 'running':
				return 'running';
			case 'interrupted':
				return 'interrupted';
			case 'completed':
				return 'completed';
			case 'shutdown':
				return 'closed';
			case 'errored':
			case 'notFound':
				return 'error';
		}
	}
	if (isError) return 'error';
	switch (action) {
		case 'close_agent':
			return 'closed';
		case 'interrupt_agent':
			return 'interrupted';
		case 'wait_agent':
			return 'waiting';
		case 'list_agents':
		case 'agent_status':
			return 'observing';
		case 'spawn_agent':
		case 'send_input':
		case 'send_message':
		case 'followup_task':
		case 'resume_agent':
			return 'running';
	}
}

function statusLabelForAgentState(agentState: CodexSubagentState): string {
	switch (agentState.status) {
		case 'pendingInit': return 'Starting';
		case 'running': return 'Running';
		case 'interrupted': return 'Interrupted';
		case 'completed': return 'Completed';
		case 'errored': return 'Error';
		case 'shutdown': return 'Stopped';
		case 'notFound': return 'Not found';
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
		case 'completed':
			return 'Completed';
		case 'closed':
			return 'Closed';
		case 'error':
			return 'Error';
		case 'observing':
			return 'Observed';
	}
}
