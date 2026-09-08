import type { AgentSettingsEnvelope } from '$shared/agent-integration';
import {
	createEmptyAgentSettings,
	normalizeAgentSettings,
} from '$shared/client/agent-settings';
import type { ChatOrderGroup } from '$shared/chat-list';
import { normalizePermissionMode, normalizeThinkingMode } from '$shared/chat-modes';
import { stableJsonStringify } from '$shared/json';
import type { ChatSessionRecord } from '$lib/types/chat-session';
import type { ChatSession } from '$lib/types/session';

export function normalizeExecutionFields<
	T extends {
		agentId: string;
		permissionMode?: unknown;
		thinkingMode?: unknown;
		agentSettings?: AgentSettingsEnvelope;
	},
>(value: T): Pick<ChatSessionRecord, 'permissionMode' | 'thinkingMode' | 'agentSettings'> {
	return {
		permissionMode: normalizePermissionMode(value.permissionMode),
		thinkingMode: normalizeThinkingMode(value.thinkingMode),
		agentSettings: normalizeAgentSettings(
			value.agentId,
			value.agentSettings,
			createEmptyAgentSettings(value.agentId),
		),
	};
}

export function toRecord(session: ChatSession): ChatSessionRecord {
	if (session.isProcessing !== (session.processingPhase !== null)) {
		throw new Error(`Invalid processing projection for chat ${session.id}`);
	}
	return {
		id: session.id,
		parentChat: session.parentChat,
		projectPath: session.projectPath,
		orderGroup: session.orderGroup,
		title: session.title,
		agentId: session.agentId,
		model: session.model,
		apiProviderId: session.apiProviderId ?? null,
		modelEndpointId: session.modelEndpointId ?? null,
		modelProtocol: session.modelProtocol ?? null,
		...normalizeExecutionFields(session),
		createdAt: session.activity?.createdAt ?? null,
		lastActivityAt: session.activity?.lastActivityAt ?? null,
		lastReadAt: session.activity?.lastReadAt ?? null,
		isPinned: session.isPinned,
		isArchived: session.isArchived ?? false,
		isProcessing: session.processingPhase !== null,
		processingPhase: session.processingPhase,
		canReloadFromNativeHistory: session.canReloadFromNativeHistory === true,
		isUnread: session.isUnread ?? false,
		status: 'running',
		agentOwnershipEpoch: session.agentOwnershipEpoch,
		lastMessage: session.preview?.lastMessage || undefined,
		tags: session.tags ?? [],
		firstMessage: session.preview?.firstMessage || undefined,
	};
}

function arraysEqual(a: string[], b: string[]): boolean {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) {
		if (a[i] !== b[i]) return false;
	}
	return true;
}

function sameParentChat(
	left: ChatSessionRecord['parentChat'],
	right: ChatSessionRecord['parentChat'],
): boolean {
	if (left === right) return true;
	if (left === null || right === null) return false;
	if (left.chatId !== right.chatId) return false;
	if (left.relation === 'delegation') return right.relation === 'delegation';
	if (right.relation === 'delegation') return false;
	return (
		left.relation === right.relation &&
		left.transcriptViewId === right.transcriptViewId &&
		left.ordinal === right.ordinal
	);
}

export function sameRecord(a: ChatSessionRecord, b: ChatSessionRecord): boolean {
	return (
		a.id === b.id &&
		sameParentChat(a.parentChat, b.parentChat) &&
		a.projectPath === b.projectPath &&
		a.orderGroup === b.orderGroup &&
		a.title === b.title &&
		a.agentId === b.agentId &&
		a.model === b.model &&
		a.apiProviderId === b.apiProviderId &&
		a.modelEndpointId === b.modelEndpointId &&
		a.modelProtocol === b.modelProtocol &&
		a.permissionMode === b.permissionMode &&
		a.thinkingMode === b.thinkingMode &&
		stableJsonStringify(a.agentSettings) === stableJsonStringify(b.agentSettings) &&
		a.createdAt === b.createdAt &&
		a.lastActivityAt === b.lastActivityAt &&
		a.lastReadAt === b.lastReadAt &&
		a.isPinned === b.isPinned &&
		a.isArchived === b.isArchived &&
		a.isProcessing === b.isProcessing &&
		a.processingPhase === b.processingPhase &&
		a.canReloadFromNativeHistory === b.canReloadFromNativeHistory &&
		a.isUnread === b.isUnread &&
		a.status === b.status &&
		a.agentOwnershipEpoch === b.agentOwnershipEpoch &&
		a.lastMessage === b.lastMessage &&
		a.firstMessage === b.firstMessage &&
		arraysEqual(a.tags, b.tags)
	);
}

export function reconcileActivityProjection(
	previous: ChatSessionRecord | undefined,
	next: ChatSessionRecord,
): void {
	if (!previous) return;
	let preservedLocalTimestamp = false;

	if (
		previous.lastActivityAt &&
		(!next.lastActivityAt || previous.lastActivityAt > next.lastActivityAt)
	) {
		next.lastActivityAt = previous.lastActivityAt;
		next.lastMessage = previous.lastMessage;
		preservedLocalTimestamp = true;
	} else if (previous.lastMessage && !next.lastMessage) {
		next.lastMessage = previous.lastMessage;
	}

	if (previous.lastReadAt && (!next.lastReadAt || previous.lastReadAt > next.lastReadAt)) {
		next.lastReadAt = previous.lastReadAt;
		preservedLocalTimestamp = true;
	}

	if (preservedLocalTimestamp) {
		next.isUnread = Boolean(
			next.lastActivityAt && (!next.lastReadAt || next.lastActivityAt > next.lastReadAt),
		);
	}
}

export function insertServerEntry(
	order: readonly string[],
	records: Readonly<Record<string, ChatSessionRecord>>,
	chatId: string,
	group: ChatOrderGroup,
	previous: ChatSessionRecord | undefined,
): string[] {
	const priorIndex = order.indexOf(chatId);
	const without = order.filter((id) => id !== chatId && Boolean(records[id]));
	if (previous?.status !== 'draft' && previous?.orderGroup === group && priorIndex >= 0) {
		without.splice(Math.min(priorIndex, without.length), 0, chatId);
		return without;
	}

	const groupRank: Record<ChatOrderGroup, number> = {
		pinned: 0,
		orphan: 1,
		normal: 2,
		archived: 3,
	};
	const draftCount = without.findIndex((id) => records[id]?.status !== 'draft');
	const serverStart = draftCount === -1 ? without.length : draftCount;
	let insertionIndex = serverStart;
	while (insertionIndex < without.length) {
		const record = records[without[insertionIndex]];
		if (!record || record.status === 'draft') {
			insertionIndex += 1;
			continue;
		}
		const recordGroup = record.orderGroup ?? 'orphan';
		if (groupRank[recordGroup] >= groupRank[group]) break;
		insertionIndex += 1;
	}
	if (group === 'normal') {
		without.splice(insertionIndex, 0, chatId);
		return without;
	}
	if (group === 'archived') {
		without.push(chatId);
		return without;
	}
	while (
		insertionIndex < without.length &&
		records[without[insertionIndex]]?.orderGroup === group
	) {
		insertionIndex += 1;
	}
	without.splice(insertionIndex, 0, chatId);
	if (group !== 'orphan') return without;

	const orphanIds = without.filter((id) => records[id]?.orderGroup === 'orphan');
	orphanIds.sort((a, b) => {
		const aCreated = records[a]?.createdAt ?? '';
		const bCreated = records[b]?.createdAt ?? '';
		return bCreated.localeCompare(aCreated) || a.localeCompare(b);
	});
	let orphanIndex = 0;
	return without.map((id) =>
		records[id]?.orderGroup === 'orphan' ? orphanIds[orphanIndex++] : id,
	);
}
