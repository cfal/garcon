import {
	AssistantMessage,
	ExternalToolUseMessage,
	McpToolUseMessage,
	PermissionRequestMessage,
	UnknownToolUseMessage,
	UserMessage,
	isToolUseMessage,
} from '$shared/chat-types';
import type { ChatDisplayRow } from '$lib/chat/transcript/active-transcript-state.svelte.js';
import {
	conversationFeedMutationKindsSince,
	type ConversationFeedMutationClock,
} from '$lib/chat/transcript/conversation-feed-mutations.js';
import {
	TOOL_DISPLAY_REGISTRY,
	getToolDisplayLabel,
} from '$lib/chat/tools/tool-display-registry.js';
import * as m from '$lib/paraglide/messages.js';

const ANNOUNCEMENT_LINEAGE_LIMIT = 512;

function rememberAnnouncementLineage(ids: Set<string>, id: string): void {
	ids.delete(id);
	ids.add(id);
	while (ids.size > ANNOUNCEMENT_LINEAGE_LIMIT) {
		const oldest = ids.values().next().value;
		if (oldest === undefined) return;
		ids.delete(oldest);
	}
}

interface ConversationFeedAnnouncerInput {
	surfaceIdentity: string;
	rows: ChatDisplayRow[];
	mutationClock: ConversationFeedMutationClock;
	visible: boolean;
	pinnedToBottom: boolean;
	isLiveWindow: boolean;
	detachedStatus: string;
	hiddenToolTypes: readonly string[];
	floatingPermissionIds: readonly string[];
}

export function announcementForAppendedRow(
	row: ChatDisplayRow,
	hiddenToolTypes: readonly string[],
): string | null {
	if (row.kind === 'local-notice') return plainAnnouncementText(row.content) || null;
	const message = row.message;
	if (message instanceof AssistantMessage || message instanceof UserMessage) {
		return plainAnnouncementText(String(message.content ?? '')) || null;
	}
	if (message instanceof PermissionRequestMessage) return m.chat_permission_permission_required();
	if (!isToolUseMessage(message)) return null;
	if (
		message instanceof UnknownToolUseMessage ||
		message instanceof ExternalToolUseMessage ||
		message instanceof McpToolUseMessage ||
		hiddenToolTypes.includes(message.type) ||
		TOOL_DISPLAY_REGISTRY[message.type]?.input.mode === 'hidden'
	) {
		return null;
	}
	return getToolDisplayLabel(message);
}

export class ConversationFeedAnnouncerState {
	#surfaceIdentity: string | null = null;
	#contentByRowId = new Map<string, string>();
	#rowIds = new Set<string>();
	#tailRowId: string | null = null;
	#floatingPermissionIds = new Set<string>();
	#observedUserRequestIds = new Set<string>();
	#observedPermissionIds = new Set<string>();
	#dataRevision = 0;
	#detachedStatusAnnounced = false;

	reconcile(input: ConversationFeedAnnouncerInput): string | null {
		if (input.surfaceIdentity !== this.#surfaceIdentity) {
			this.#surfaceIdentity = input.surfaceIdentity;
			this.#contentByRowId = this.#visibleContentByRowId(input.rows);
			this.#rowIds = new Set(input.rows.map((row) => row.id));
			this.#tailRowId = input.rows.at(-1)?.id ?? null;
			this.#floatingPermissionIds = new Set(input.floatingPermissionIds);
			this.#observedUserRequestIds = this.#userRequestIds(input.rows);
			this.#observedPermissionIds = this.#permissionIds(input.rows, input.floatingPermissionIds);
			this.#dataRevision = input.mutationClock.dataRevision;
			this.#detachedStatusAnnounced = false;
			return '';
		}

		const kinds = conversationFeedMutationKindsSince(input.mutationClock, this.#dataRevision);
		const priorContent = this.#contentByRowId;
		const priorRowIds = this.#rowIds;
		const priorTailIndex = this.#tailRowId
			? input.rows.findIndex((row) => row.id === this.#tailRowId)
			: -1;
		const appendedRows =
			priorTailIndex >= 0
				? input.rows.slice(priorTailIndex + 1)
				: (() => {
						let lastKnownIndex = -1;
						for (let index = input.rows.length - 1; index >= 0; index -= 1) {
							if (priorRowIds.has(input.rows[index].id)) {
								lastKnownIndex = index;
								break;
							}
						}
						const newRows = input.rows
							.slice(lastKnownIndex + 1)
							.filter((row) => !priorRowIds.has(row.id));
						return lastKnownIndex >= 0 ? newRows : newRows.slice(-1);
					})();
		const nextContent = this.#visibleContentByRowId(input.rows);
		const streamedRows = input.rows.filter((row) => {
			const prior = priorContent.get(row.id);
			const next = nextContent.get(row.id);
			return prior !== undefined && next !== undefined && next !== prior;
		});
		const nextFloatingPermissionIds = new Set(input.floatingPermissionIds);
		const addedFloatingPermissionIds = input.floatingPermissionIds.filter(
			(id) => !this.#floatingPermissionIds.has(id),
		);
		this.#contentByRowId = nextContent;
		this.#rowIds = new Set(input.rows.map((row) => row.id));
		this.#tailRowId = input.rows.at(-1)?.id ?? null;
		this.#floatingPermissionIds = nextFloatingPermissionIds;
		this.#dataRevision = input.mutationClock.dataRevision;
		const resumedLiveEnd =
			this.#detachedStatusAnnounced && input.visible && input.isLiveWindow && input.pinnedToBottom;
		if (resumedLiveEnd) this.#detachedStatusAnnounced = false;
		if (!input.visible || !input.isLiveWindow) {
			this.#rememberLineages(input.rows, input.floatingPermissionIds);
			return '';
		}
		const hasRowAppend = kinds.has('live-append') || kinds.has('presentation-structure');
		if (!hasRowAppend && addedFloatingPermissionIds.length === 0) {
			return resumedLiveEnd ? '' : null;
		}

		const candidatesById = new Map<string, ChatDisplayRow>();
		for (const row of [...appendedRows, ...streamedRows]) candidatesById.set(row.id, row);
		const candidates = [...candidatesById.values()];
		const announcementCandidates = candidates.filter((row) => {
			if (row.kind !== 'message') return true;
			if (row.message instanceof UserMessage) {
				const requestId = row.message.metadata?.clientRequestId;
				if (!requestId) return true;
				if (this.#observedUserRequestIds.has(requestId)) return false;
				rememberAnnouncementLineage(this.#observedUserRequestIds, requestId);
			}
			if (row.message instanceof PermissionRequestMessage) {
				const permissionId = row.message.permissionRequestId;
				if (this.#observedPermissionIds.has(permissionId)) return false;
				rememberAnnouncementLineage(this.#observedPermissionIds, permissionId);
			}
			return true;
		});
		const addedPermissionAnnouncements = addedFloatingPermissionIds.filter((permissionId) => {
			if (this.#observedPermissionIds.has(permissionId)) return false;
			rememberAnnouncementLineage(this.#observedPermissionIds, permissionId);
			return true;
		});
		const responseUpdated =
			addedPermissionAnnouncements.length > 0 ||
			announcementCandidates.some((row) =>
				this.#isResponseAnnouncement(row, input.hiddenToolTypes),
			);
		if (!input.pinnedToBottom) {
			if (!responseUpdated || this.#detachedStatusAnnounced) return null;
			this.#detachedStatusAnnounced = true;
			return input.detachedStatus;
		}

		const announcements = announcementCandidates.flatMap((row) => {
			if (row.kind === 'message' && row.message instanceof AssistantMessage) {
				const next = nextContent.get(row.id) ?? '';
				const prior = priorContent.get(row.id) ?? '';
				const suffix = prior && next.startsWith(prior) ? next.slice(prior.length) : next;
				const content = plainAnnouncementText(suffix);
				return content ? [content] : [];
			}
			const content = announcementForAppendedRow(row, input.hiddenToolTypes);
			return content ? [content] : [];
		});
		for (const _permissionId of addedPermissionAnnouncements) {
			announcements.push(m.chat_permission_permission_required());
		}
		return announcements.join('\n') || null;
	}

	#isResponseAnnouncement(row: ChatDisplayRow, hiddenToolTypes: readonly string[]): boolean {
		if (row.kind !== 'message') return false;
		if (
			row.message instanceof AssistantMessage ||
			row.message instanceof PermissionRequestMessage
		) {
			return true;
		}
		return (
			isToolUseMessage(row.message) && announcementForAppendedRow(row, hiddenToolTypes) !== null
		);
	}

	#rememberLineages(rows: ChatDisplayRow[], floatingPermissionIds: readonly string[]): void {
		for (const requestId of this.#userRequestIds(rows)) {
			rememberAnnouncementLineage(this.#observedUserRequestIds, requestId);
		}
		for (const permissionId of this.#permissionIds(rows, floatingPermissionIds)) {
			rememberAnnouncementLineage(this.#observedPermissionIds, permissionId);
		}
	}

	#userRequestIds(rows: ChatDisplayRow[]): Set<string> {
		return new Set(
			rows
				.flatMap((row) => {
					if (row.kind !== 'message' || !(row.message instanceof UserMessage)) return [];
					const requestId = row.message.metadata?.clientRequestId;
					return requestId ? [requestId] : [];
				})
				.slice(-ANNOUNCEMENT_LINEAGE_LIMIT),
		);
	}

	#permissionIds(rows: ChatDisplayRow[], floatingPermissionIds: readonly string[]): Set<string> {
		return new Set(
			[
				...rows.flatMap((row) =>
					row.kind === 'message' && row.message instanceof PermissionRequestMessage
						? [row.message.permissionRequestId]
						: [],
				),
				...floatingPermissionIds,
			].slice(-ANNOUNCEMENT_LINEAGE_LIMIT),
		);
	}

	#visibleContentByRowId(rows: ChatDisplayRow[]): Map<string, string> {
		return new Map(
			rows.flatMap((row) => {
				if (row.kind !== 'message') return [];
				if (!(row.message instanceof AssistantMessage || row.message instanceof UserMessage)) {
					return [];
				}
				return [[row.id, String(row.message.content ?? '')] as const];
			}),
		);
	}

	reset(): void {
		this.#surfaceIdentity = null;
		this.#contentByRowId.clear();
		this.#rowIds.clear();
		this.#tailRowId = null;
		this.#floatingPermissionIds.clear();
		this.#observedUserRequestIds.clear();
		this.#observedPermissionIds.clear();
		this.#dataRevision = 0;
		this.#detachedStatusAnnounced = false;
	}
}

export function plainAnnouncementText(source: string): string {
	return source
		.replace(/```[\s\S]*?```/g, ' code block ')
		.replace(/`([^`]+)`/g, '$1')
		.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
		.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
		.replace(/^\s{0,3}(?:#{1,6}|>|[-*+] |\d+[.)] )\s*/gm, '')
		.replace(/[*_~]/g, '')
		.replace(/\s+/g, ' ')
		.trim();
}
