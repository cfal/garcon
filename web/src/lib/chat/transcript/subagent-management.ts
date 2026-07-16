import {
	CodexSubagentToolUseMessage,
	ToolResultMessage,
	UserMessage,
	codexSubagentSourceFingerprint,
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

interface ReducerEntryMetadata {
	statusOrder: number;
	messageOrder: number;
	resetOrder: number;
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
	const reducerMetadata = new Map<SubagentManagementEntry, ReducerEntryMetadata>();
	const knownAliases = collectKnownAliases(messages, resultsByToolId);
	const userSourceFingerprints = new Set(
		messages
			.filter((message): message is UserMessage => message instanceof UserMessage)
			.map((message) => codexSubagentSourceFingerprint(message.content)),
	);
	let eventOrder = 0;

	for (const message of messages) {
		if (!(message instanceof CodexSubagentToolUseMessage)) continue;

		const result = resultsByToolId.get(message.toolId);
		for (const rawDetails of entryDetailsForMessage(message)) {
			eventOrder += 1;
			const eventDetails = detailsWithSpawnResult(rawDetails, message.action, result);
			if (isRejectedTextLifecycle(message.action, eventDetails, knownAliases, userSourceFingerprints)) continue;
			const key = resolveEntryKey(
				eventDetails,
				message.toolId,
				aliasToKey,
				message.action,
			);
			if (!key) continue;

			let entry = subagentsByKey.get(key);
			if (!entry) {
				entry = createSubagentEntry(key, message, eventDetails);
				reducerMetadata.set(entry, { statusOrder: -1, messageOrder: -1, resetOrder: -1 });
				subagentsByKey.set(key, entry);
				orderedSubagents.push(entry);
			}

			entry = coalesceAliasedEntries(
				entry,
				eventDetails,
				subagentsByKey,
				aliasToKey,
				orderedSubagents,
				reducerMetadata,
			);
			registerAliases(entry.id, eventDetails, aliasToKey);
			applySubagentEvent(
				entry,
				message,
				result,
				eventDetails,
				eventOrder,
				reducerMetadata.get(entry)!,
			);
		}
	}

	if (rootStatus === 'idle') {
		// An idle Garcon session has shut down its dedicated Codex client and workers.
		for (const entry of orderedSubagents) {
			if (entry.status === 'running' || entry.status === 'waiting' || entry.status === 'observing') {
				entry.status = 'closed';
				entry.statusLabel = 'Stopped';
			}
		}
	}

	return {
		entries: [rootEntry, ...orderedSubagents],
		subagents: orderedSubagents,
	};
}

function collectKnownAliases(
	messages: ChatMessage[],
	resultsByToolId: Map<string, ToolResultMessage>,
): Set<string> {
	const aliases = new Set<string>();
	for (const message of messages) {
		if (!(message instanceof CodexSubagentToolUseMessage) || message.action === 'list_agents') continue;
		const result = resultsByToolId.get(message.toolId);
		for (const rawDetails of entryDetailsForMessage(message)) {
			const details = detailsWithSpawnResult(rawDetails, message.action, result);
			if (message.action === 'agent_status' && !details.threadId) continue;
			for (const alias of aliasesFor(details)) aliases.add(normalizeAlias(alias));
		}
	}
	return aliases;
}

function isRejectedTextLifecycle(
	action: CodexSubagentAction,
	details: CodexSubagentDetails,
	knownAliases: Set<string>,
	userSourceFingerprints: Set<string>,
): boolean {
	if (action !== 'agent_status' || details.lifecycleSource === 'structured') return false;
	if (
		details.lifecycleSource === 'legacy'
		&& details.sourceFingerprint
		&& userSourceFingerprints.has(details.sourceFingerprint)
	) return true;
	return !details.threadId
		&& !aliasesFor(details).some((alias) => knownAliases.has(normalizeAlias(alias)));
}

function detailsWithSpawnResult(
	details: CodexSubagentDetails,
	action: CodexSubagentAction,
	result: ToolResultMessage | undefined,
): CodexSubagentDetails {
	if (action !== 'spawn_agent' || !result || result.isError) return details;
	const agentId = resultString(result.content, 'agent_id');
	const nickname = resultString(result.content, 'nickname');
	if (!agentId && !nickname) return details;
	return {
		...details,
		...(agentId ? { threadId: details.threadId ?? agentId } : {}),
		...(nickname && !details.taskName ? { taskName: nickname } : {}),
	};
}

function resultString(content: Record<string, unknown>, key: string): string | undefined {
	const value = content[key];
	if (typeof value === 'string' && value.trim()) return value.trim();
	if (typeof content.raw !== 'string') return undefined;
	try {
		const parsed: unknown = JSON.parse(content.raw);
		if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
		const nested = (parsed as Record<string, unknown>)[key];
		return typeof nested === 'string' && nested.trim() ? nested.trim() : undefined;
	} catch {
		return undefined;
	}
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
		path: preferredPath(details),
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
	eventOrder: number,
	metadata: ReducerEntryMetadata,
): void {
	entry.name = preferredDisplayName(details, entry.name, entry.id);
	entry.path = preferredPath(details) ?? entry.path;
	entry.model = details.model ?? entry.model;
	entry.lastActionLabel = actionLabelFor(message.action);
	const agentState = stateForDetails(details);
	const nextStatus = statusFor(message.action, result?.isError === true, agentState);
	const keepExisting = keepsExistingStatus(entry.status, nextStatus, message.action);
	if (!keepExisting) {
		entry.status = nextStatus;
		entry.statusLabel = agentState ? statusLabelForAgentState(agentState) : statusLabelFor(nextStatus);
		metadata.statusOrder = eventOrder;
		if (isExplicitResetAction(message.action)) metadata.resetOrder = eventOrder;
	}
	const nextMessage = agentState?.message ?? details.message;
	if (nextMessage !== undefined && (!keepExisting || !isProtectedStatus(entry.status))) {
		entry.message = nextMessage;
		metadata.messageOrder = eventOrder;
	}
}

function isExplicitResetAction(action: CodexSubagentAction): boolean {
	return action === 'resume_agent'
		|| action === 'send_input'
		|| action === 'send_message'
		|| action === 'followup_task';
}

function keepsExistingStatus(
	current: SubagentManagementStatus,
	next: SubagentManagementStatus,
	action: CodexSubagentAction,
): boolean {
	if (!isProtectedStatus(current) || isProtectedStatus(next)) return false;
	return action !== 'resume_agent'
		&& action !== 'send_input'
		&& action !== 'send_message'
		&& action !== 'followup_task';
}

function isProtectedStatus(status: SubagentManagementStatus): boolean {
	return status === 'interrupted'
		|| status === 'completed'
		|| status === 'closed'
		|| status === 'error';
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
	if (details.threadId) return normalizeAlias(details.threadId);
	if (identity) return normalizeAlias(identity);
	if (action === 'spawn_agent') return normalizeAlias(fallback);
	return null;
}

function coalesceAliasedEntries(
	entry: SubagentManagementEntry,
	details: CodexSubagentDetails,
	subagentsByKey: Map<string, SubagentManagementEntry>,
	aliasToKey: Map<string, string>,
	orderedSubagents: SubagentManagementEntry[],
	reducerMetadata: Map<SubagentManagementEntry, ReducerEntryMetadata>,
): SubagentManagementEntry {
	const keys = new Set<string>();
	for (const alias of aliasesFor(details)) {
		const key = aliasToKey.get(normalizeAlias(alias));
		if (key) keys.add(key);
	}
	keys.add(entry.id);
	if (keys.size < 2) return entry;

	const entries = orderedSubagents.filter((candidate) => keys.has(candidate.id));
	const primary = entries[0] ?? entry;
	for (const duplicate of entries.slice(1)) {
		mergeSubagentEntry(
			primary,
			duplicate,
			reducerMetadata.get(primary)!,
			reducerMetadata.get(duplicate)!,
		);
		reducerMetadata.delete(duplicate);
		subagentsByKey.delete(duplicate.id);
		const index = orderedSubagents.indexOf(duplicate);
		if (index >= 0) orderedSubagents.splice(index, 1);
		for (const [alias, key] of aliasToKey) {
			if (key === duplicate.id) aliasToKey.set(alias, primary.id);
		}
	}
	return primary;
}

function mergeSubagentEntry(
	primary: SubagentManagementEntry,
	duplicate: SubagentManagementEntry,
	primaryMetadata: ReducerEntryMetadata,
	duplicateMetadata: ReducerEntryMetadata,
): void {
	if (!primary.path || isCanonicalPath(duplicate.path)) primary.path = duplicate.path ?? primary.path;
	if (isCanonicalPath(duplicate.path)) primary.name = duplicate.name;
	primary.model ??= duplicate.model;
	primary.anchorId ??= duplicate.anchorId;
	if (duplicateMetadata.messageOrder > primaryMetadata.messageOrder) {
		primary.message = duplicate.message;
		primaryMetadata.messageOrder = duplicateMetadata.messageOrder;
	} else {
		primary.message ??= duplicate.message;
	}
	if (
		isProtectedStatus(duplicate.status)
		&& (
			(isProtectedStatus(primary.status) && duplicateMetadata.statusOrder > primaryMetadata.statusOrder)
			|| (!isProtectedStatus(primary.status) && duplicateMetadata.statusOrder > primaryMetadata.resetOrder)
		)
	) {
		primary.status = duplicate.status;
		primary.statusLabel = duplicate.statusLabel;
		primaryMetadata.statusOrder = duplicateMetadata.statusOrder;
		if (duplicateMetadata.messageOrder >= primaryMetadata.messageOrder) {
			primary.message = duplicate.message ?? primary.message;
		}
	} else if (
		isProtectedStatus(primary.status)
		&& !isProtectedStatus(duplicate.status)
		&& duplicateMetadata.resetOrder > primaryMetadata.statusOrder
	) {
		primary.status = duplicate.status;
		primary.statusLabel = duplicate.statusLabel;
		primaryMetadata.statusOrder = duplicateMetadata.statusOrder;
	}
	primaryMetadata.resetOrder = Math.max(primaryMetadata.resetOrder, duplicateMetadata.resetOrder);
}

function registerAliases(
	key: string,
	details: CodexSubagentDetails,
	aliasToKey: Map<string, string>,
): void {
	for (const alias of aliasesFor(details)) {
		aliasToKey.set(normalizeAlias(alias), key);
	}
}

function aliasesFor(details: CodexSubagentDetails): string[] {
	return [
		details.target,
		details.threadId,
		details.pathPrefix,
		details.taskName,
		details.taskName ? `/root/${details.taskName}` : undefined,
	].filter((alias): alias is string => Boolean(alias));
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

function preferredDisplayName(
	details: CodexSubagentDetails,
	fallback: string,
	entryId: string,
): string {
	if (details.taskName) return details.taskName;
	if (details.target && normalizeAlias(details.target) === entryId) return fallback;
	const path = preferredPath(details);
	if (path) return path.split('/').filter(Boolean).at(-1) ?? path;
	if (!isCanonicalPath(fallback) && details.target && !looksLikeThreadId(details.target)) {
		return displayNameFor(details, fallback);
	}
	return fallback;
}

function preferredPath(details: CodexSubagentDetails): string | undefined {
	if (isCanonicalPath(details.target)) return details.target;
	if (isCanonicalPath(details.pathPrefix)) return details.pathPrefix;
	if (details.pathPrefix) return details.pathPrefix;
	if (details.taskName?.startsWith('/')) return details.taskName;
	if (details.target && !looksLikeThreadId(details.target)) return details.target;
	return undefined;
}

function isCanonicalPath(value: string | undefined): value is string {
	return Boolean(value?.startsWith('/root/'));
}

function looksLikeThreadId(value: string): boolean {
	return /^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(value) || value.startsWith('worker-thread-');
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
