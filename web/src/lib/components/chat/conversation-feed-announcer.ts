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
export const CHAT_FEED_ANNOUNCEMENT_BATCH_MS = 350;

export type ConversationFeedAnnouncementChunk =
	{ kind: 'stream'; rowId: string; source: string } | { kind: 'discrete'; text: string };

export type ConversationFeedAnnouncementUpdate =
	{ kind: 'clear' } | { kind: 'announce'; chunks: ConversationFeedAnnouncementChunk[] };

function isAnnounceableResponseMessageType(
	messageType: string,
	hiddenToolTypes: readonly string[],
): boolean {
	if (messageType === 'assistant-message' || messageType === 'permission-request') return true;
	if (
		messageType === 'unknown-tool-use' ||
		messageType === 'external-tool-use' ||
		messageType === 'mcp-tool-use' ||
		hiddenToolTypes.includes(messageType)
	) {
		return false;
	}
	const displayRule = TOOL_DISPLAY_REGISTRY[messageType];
	return displayRule !== undefined && displayRule.input.mode !== 'hidden';
}

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
	floatingPermissionOccurrences: readonly string[];
}

function announcementText(update: ConversationFeedAnnouncementUpdate): string {
	if (update.kind === 'clear') return '';
	return update.chunks
		.map((chunk) => (chunk.kind === 'stream' ? plainAnnouncementText(chunk.source) : chunk.text))
		.filter(Boolean)
		.join('\n');
}

export class ConversationFeedAnnouncementBatcher {
	#pending: ConversationFeedAnnouncementChunk[] = [];
	#timer: ReturnType<typeof setTimeout> | null = null;

	constructor(private readonly publish: (text: string) => void) {}

	enqueue(update: ConversationFeedAnnouncementUpdate): void {
		if (update.kind === 'clear') {
			this.#cancelPending();
			this.publish('');
			return;
		}

		for (const chunk of update.chunks) {
			const previous = this.#pending.at(-1);
			if (
				chunk.kind === 'stream' &&
				previous?.kind === 'stream' &&
				previous.rowId === chunk.rowId
			) {
				previous.source += chunk.source;
			} else {
				this.#pending.push({ ...chunk });
			}
		}
		if (this.#timer !== null || this.#pending.length === 0) return;
		this.#timer = setTimeout(() => this.#flush(), CHAT_FEED_ANNOUNCEMENT_BATCH_MS);
	}

	destroy(): void {
		this.#cancelPending();
	}

	#flush(): void {
		this.#timer = null;
		const update = { kind: 'announce' as const, chunks: this.#pending };
		this.#pending = [];
		const text = announcementText(update);
		if (text) this.publish(text);
	}

	#cancelPending(): void {
		if (this.#timer !== null) clearTimeout(this.#timer);
		this.#timer = null;
		this.#pending = [];
	}
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
	#floatingPermissionOccurrences = new Set<string>();
	#observedUserRequestIds = new Set<string>();
	#observedPermissionOccurrences = new Set<string>();
	#dataRevision = 0;
	#detachedStatusAnnounced = false;
	#isLiveWindow: boolean | null = null;

	reconcile(input: ConversationFeedAnnouncerInput): string | null {
		const update = this.reconcileUpdate(input);
		if (update === null) return null;
		return announcementText(update) || (update.kind === 'clear' ? '' : null);
	}

	reconcileUpdate(
		input: ConversationFeedAnnouncerInput,
	): ConversationFeedAnnouncementUpdate | null {
		const tailRows = input.rows.slice(-ANNOUNCEMENT_LINEAGE_LIMIT);
		if (input.surfaceIdentity !== this.#surfaceIdentity) {
			this.#surfaceIdentity = input.surfaceIdentity;
			this.#contentByRowId = this.#visibleContentByRowId(tailRows);
			this.#rowIds = new Set(tailRows.map((row) => row.id));
			this.#tailRowId = tailRows.at(-1)?.id ?? null;
			this.#floatingPermissionOccurrences = new Set(input.floatingPermissionOccurrences);
			this.#observedUserRequestIds = this.#userRequestIds(tailRows);
			this.#observedPermissionOccurrences = this.#permissionOccurrences(
				tailRows,
				input.floatingPermissionOccurrences,
			);
			this.#dataRevision = input.mutationClock.dataRevision;
			this.#detachedStatusAnnounced = false;
			this.#isLiveWindow = input.isLiveWindow;
			return { kind: 'clear' };
		}

		const previousDataRevision = this.#dataRevision;
		const windowModeChanged = this.#isLiveWindow !== input.isLiveWindow;
		const clearedDetachedStatus = windowModeChanged && this.#detachedStatusAnnounced;
		if (windowModeChanged) {
			this.#detachedStatusAnnounced = false;
			this.#isLiveWindow = input.isLiveWindow;
		}
		const kinds = conversationFeedMutationKindsSince(input.mutationClock, previousDataRevision);
		const priorContent = this.#contentByRowId;
		const priorRowIds = this.#rowIds;
		const priorTailIndex = this.#tailRowId
			? tailRows.findIndex((row) => row.id === this.#tailRowId)
			: -1;
		const appendedRows =
			priorTailIndex >= 0
				? tailRows.slice(priorTailIndex + 1)
				: (() => {
						let lastKnownIndex = -1;
						for (let index = tailRows.length - 1; index >= 0; index -= 1) {
							if (priorRowIds.has(tailRows[index].id)) {
								lastKnownIndex = index;
								break;
							}
						}
						const newRows = tailRows
							.slice(lastKnownIndex + 1)
							.filter((row) => !priorRowIds.has(row.id));
						return lastKnownIndex >= 0 ? newRows : newRows.slice(-1);
					})();
		const nextContent = this.#visibleContentByRowId(tailRows);
		const streamedRows = tailRows.filter((row) => {
			const prior = priorContent.get(row.id);
			const next = nextContent.get(row.id);
			return prior !== undefined && next !== undefined && next !== prior;
		});
		const nextFloatingPermissionOccurrences = new Set(input.floatingPermissionOccurrences);
		const addedFloatingPermissionOccurrences = input.floatingPermissionOccurrences.filter(
			(occurrence) => !this.#floatingPermissionOccurrences.has(occurrence),
		);
		this.#contentByRowId = nextContent;
		this.#rowIds = new Set(tailRows.map((row) => row.id));
		this.#tailRowId = tailRows.at(-1)?.id ?? null;
		this.#floatingPermissionOccurrences = nextFloatingPermissionOccurrences;
		this.#dataRevision = input.mutationClock.dataRevision;
		const resumedLiveEnd =
			this.#detachedStatusAnnounced && input.visible && input.isLiveWindow && input.pinnedToBottom;
		if (resumedLiveEnd) this.#detachedStatusAnnounced = false;
		const responseUpdatedOutsideWindow =
			!input.isLiveWindow &&
			Object.entries(input.mutationClock.lastResponseRevisionByMessageType).some(
				([messageType, revision]) =>
					revision > previousDataRevision &&
					isAnnounceableResponseMessageType(messageType, input.hiddenToolTypes),
			);
		const addedPermissionAnnouncements = addedFloatingPermissionOccurrences.filter((occurrence) => {
			if (this.#observedPermissionOccurrences.has(occurrence)) return false;
			rememberAnnouncementLineage(this.#observedPermissionOccurrences, occurrence);
			return true;
		});
		if (!input.visible) {
			this.#rememberLineages(tailRows, input.floatingPermissionOccurrences);
			return { kind: 'clear' };
		}
		if (!input.isLiveWindow) {
			this.#rememberLineages(tailRows, input.floatingPermissionOccurrences);
			if (
				this.#detachedStatusAnnounced ||
				(!responseUpdatedOutsideWindow && addedPermissionAnnouncements.length === 0)
			) {
				return clearedDetachedStatus ? { kind: 'clear' } : null;
			}
			this.#detachedStatusAnnounced = true;
			return {
				kind: 'announce',
				chunks: [{ kind: 'discrete', text: input.detachedStatus }],
			};
		}
		const hasRowAppend = kinds.has('live-append') || kinds.has('presentation-structure');
		if (!hasRowAppend && addedFloatingPermissionOccurrences.length === 0) {
			return resumedLiveEnd || clearedDetachedStatus ? { kind: 'clear' } : null;
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
				const occurrence = row.message.permissionOccurrenceId;
				if (this.#observedPermissionOccurrences.has(occurrence)) return false;
				rememberAnnouncementLineage(this.#observedPermissionOccurrences, occurrence);
			}
			return true;
		});
		const responseUpdated =
			addedPermissionAnnouncements.length > 0 ||
			announcementCandidates.some((row) =>
				this.#isResponseAnnouncement(row, input.hiddenToolTypes),
			);
		if (!input.pinnedToBottom) {
			if (!responseUpdated || this.#detachedStatusAnnounced) {
				return clearedDetachedStatus ? { kind: 'clear' } : null;
			}
			this.#detachedStatusAnnounced = true;
			return {
				kind: 'announce',
				chunks: [{ kind: 'discrete', text: input.detachedStatus }],
			};
		}

		const announcements = announcementCandidates.flatMap(
			(row): ConversationFeedAnnouncementChunk[] => {
				if (row.kind === 'message' && row.message instanceof AssistantMessage) {
					const next = nextContent.get(row.id) ?? '';
					const prior = priorContent.get(row.id) ?? '';
					const suffix = prior && next.startsWith(prior) ? next.slice(prior.length) : next;
					return suffix ? [{ kind: 'stream', rowId: row.id, source: suffix }] : [];
				}
				const content = announcementForAppendedRow(row, input.hiddenToolTypes);
				return content ? [{ kind: 'discrete', text: content }] : [];
			},
		);
		for (const _occurrence of addedPermissionAnnouncements) {
			announcements.push({
				kind: 'discrete',
				text: m.chat_permission_permission_required(),
			});
		}
		if (announcements.length > 0) return { kind: 'announce', chunks: announcements };
		return clearedDetachedStatus ? { kind: 'clear' } : null;
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

	#rememberLineages(rows: ChatDisplayRow[], floatingPermissionOccurrences: readonly string[]): void {
		for (const requestId of this.#userRequestIds(rows)) {
			rememberAnnouncementLineage(this.#observedUserRequestIds, requestId);
		}
		for (const occurrence of this.#permissionOccurrences(rows, floatingPermissionOccurrences)) {
			rememberAnnouncementLineage(this.#observedPermissionOccurrences, occurrence);
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

	#permissionOccurrences(
		rows: ChatDisplayRow[],
		floatingPermissionOccurrences: readonly string[],
	): Set<string> {
		return new Set(
			[
				...rows.flatMap((row) =>
					row.kind === 'message' && row.message instanceof PermissionRequestMessage
						? [row.message.permissionOccurrenceId]
						: [],
				),
				...floatingPermissionOccurrences,
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
		this.#floatingPermissionOccurrences.clear();
		this.#observedUserRequestIds.clear();
		this.#observedPermissionOccurrences.clear();
		this.#dataRevision = 0;
		this.#detachedStatusAnnounced = false;
		this.#isLiveWindow = null;
	}
}

export function plainAnnouncementText(source: string): string {
	return source
		.replace(/```[\s\S]*?```/g, ` ${m.chat_feed_announcement_code_block()} `)
		.replace(/`([^`]+)`/g, '$1')
		.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
		.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
		.replace(/^\s{0,3}(?:#{1,6}|>|[-*+] |\d+[.)] )\s*/gm, '')
		.replace(/[*_~]/g, '')
		.replace(/\s+/g, ' ')
		.trim();
}
