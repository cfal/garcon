import { AssistantMessage, UserMessage } from '$shared/chat-types';
import type { ChatDisplayRow } from '$lib/chat/transcript/active-transcript-state.svelte.js';
import {
	conversationFeedMutationKindsSince,
	type ConversationFeedMutationClock,
} from '$lib/chat/transcript/conversation-feed-mutations.js';

export class ConversationFeedAnnouncerState {
	#surfaceIdentity: string | null = null;
	#contentByRowId = new Map<string, string>();
	#tailRowId: string | null = null;
	#dataRevision = 0;
	#detachedStatusAnnounced = false;

	reconcile(input: {
		surfaceIdentity: string;
		rows: ChatDisplayRow[];
		mutationClock: ConversationFeedMutationClock;
		visible: boolean;
		pinnedToBottom: boolean;
		isLiveWindow: boolean;
		detachedStatus: string;
	}): string | null {
		if (input.surfaceIdentity !== this.#surfaceIdentity) {
			this.#surfaceIdentity = input.surfaceIdentity;
			this.#contentByRowId = this.#visibleContentByRowId(input.rows);
			this.#tailRowId = input.rows.at(-1)?.id ?? null;
			this.#dataRevision = input.mutationClock.dataRevision;
			this.#detachedStatusAnnounced = false;
			return '';
		}

		const kinds = conversationFeedMutationKindsSince(input.mutationClock, this.#dataRevision);
		const priorContent = this.#contentByRowId;
		const priorTailIndex = this.#tailRowId
			? input.rows.findIndex((row) => row.id === this.#tailRowId)
			: -1;
		const appendedRows = priorTailIndex >= 0 ? input.rows.slice(priorTailIndex + 1) : [];
		const nextContent = this.#visibleContentByRowId(input.rows);
		const streamedRows = input.rows.filter((row) => {
			const prior = priorContent.get(row.id);
			const next = nextContent.get(row.id);
			return prior !== undefined && next !== undefined && next !== prior;
		});
		this.#contentByRowId = nextContent;
		this.#tailRowId = input.rows.at(-1)?.id ?? null;
		this.#dataRevision = input.mutationClock.dataRevision;
		const resumedLiveEnd =
			this.#detachedStatusAnnounced &&
			input.visible &&
			input.isLiveWindow &&
			input.pinnedToBottom;
		if (resumedLiveEnd) {
			this.#detachedStatusAnnounced = false;
		}
		if (!input.visible || !input.isLiveWindow) return '';
		if (!kinds.has('live-append')) return resumedLiveEnd ? '' : null;

		const candidates = [...appendedRows, ...streamedRows];
		const assistantUpdated = candidates.some(
			(row) => row.kind === 'message' && row.message instanceof AssistantMessage,
		);
		if (!input.pinnedToBottom) {
			if (!assistantUpdated || this.#detachedStatusAnnounced) return null;
			this.#detachedStatusAnnounced = true;
			return input.detachedStatus;
		}

		const announcement = candidates
			.flatMap((row) => {
				if (row.kind !== 'message') return [];
				if (!(row.message instanceof AssistantMessage || row.message instanceof UserMessage)) {
					return [];
				}
				const next = nextContent.get(row.id) ?? '';
				const prior = streamedRows.includes(row) ? (priorContent.get(row.id) ?? '') : '';
				const suffix = prior && next.startsWith(prior) ? next.slice(prior.length) : next;
				const content = plainAnnouncementText(suffix);
				return content ? [content] : [];
			})
			.join('\n');
		return announcement || null;
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
		this.#tailRowId = null;
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
