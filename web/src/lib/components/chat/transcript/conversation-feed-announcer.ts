import { isToolUseMessage } from '$shared/chat-types';
import { RESPONSE_CLASSES, emptyResponseClassOrdinals, type ResponseClassOrdinals } from '$shared/transcript-display-events';
import type { ChatDisplayRow } from '$lib/chat/transcript/transcript-row-projection.js';
import { cliPresentationLabel } from '$lib/chat/transcript/cli-presentation-style.js';
import { commandResultPresentation } from '$lib/chat/transcript/command-result-presentation.js';
import { TOOL_DISPLAY_REGISTRY, getToolDisplayLabel } from '$lib/chat/tools/tool-display-registry.js';
import * as m from '$lib/paraglide/messages.js';

export const CHAT_FEED_ANNOUNCEMENT_BATCH_MS = 350;
export type ConversationFeedAnnouncementUpdate =
	{ kind: 'clear' } | { kind: 'announce'; chunks: string[] };

interface ConversationFeedAnnouncerInput {
	surfaceIdentity: string;
	rows: readonly ChatDisplayRow[];
	watermark: number;
	initialHead: number;
	sourceHead: number;
	responseClassOrdinals: ResponseClassOrdinals;
	visible: boolean;
	pinnedToBottom: boolean;
	detachedStatus: string;
	floatingPermissionOccurrences: readonly string[];
}
function announcementText(update: ConversationFeedAnnouncementUpdate): string {
	return update.kind === 'clear' ? '' : update.chunks.filter(Boolean).join('\n');
}
export class ConversationFeedAnnouncementBatcher {
	#pending: string[] = [];
	#timer: ReturnType<typeof setTimeout> | null = null;

	constructor(private readonly publish: (text: string) => void) {}

	enqueue(update: ConversationFeedAnnouncementUpdate): void {
		if (update.kind === 'clear') {
			this.#cancelPending();
			this.publish('');
			return;
		}

		this.#pending.push(...update.chunks);
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


export function announcementForAppendedRow(row: ChatDisplayRow): string | null {
	if (row.kind === 'local-notice') return plainAnnouncementText(row.content) || null;
	const message = row.message;
	if (message.type === 'permission-request') return m.chat_permission_permission_required();
	if (message.type === 'command-result' && commandResultPresentation(message.result) === 'hidden') return null;
	if (message.type === 'command-output' || message.type === 'command-result'
		|| message.type === 'user-message' && message.metadata?.contentMode === 'literal') {
		return message.content.length <= 4096 ? message.content : `${message.content.slice(0, 4096)}...`;
	}
	if (message.type === 'cli-row' || message.type === 'user-message' && message.presentation?.style) {
		const presentation = message.presentation!;
		const title = message.type === 'cli-row' ? message.title : message.presentation?.title;
		const body = plainAnnouncementText(message.content);
		return `${cliPresentationLabel(presentation.style!)}${title ? `: ${title}` : ''}.${body ? ` ${body}` : ''}`;
	}
	if (message.type === 'assistant-message' || message.type === 'user-message'
		|| message.type === 'error' || message.type === 'thinking') return plainAnnouncementText(message.content).slice(0, 4096) || null;
	if (isToolUseMessage(message) && !['unknown-tool-use', 'external-tool-use', 'mcp-tool-use'].includes(message.type)
		&& TOOL_DISPLAY_REGISTRY[message.type]?.input.mode !== 'hidden') return getToolDisplayLabel(message);
	return null;
}

function announcementLineage(row: ChatDisplayRow): string | null {
	if (row.kind === 'local-notice') return row.id;
	if (row.message.type === 'permission-request') return `permission:${row.message.permissionOccurrenceId}`;
	if (row.message.type !== 'user-message') return null;
	const id = row.message.metadata?.clientMessageId ?? row.message.metadata?.clientRequestId;
	if (id) return `input:${id}`;
	return row.ordinal === undefined ? row.id : null;
}

export class ConversationFeedAnnouncerState {
	#surface = '';
	#watermark = 0;
	#responses: ResponseClassOrdinals = emptyResponseClassOrdinals();
	#lineages = new Set<string>();
	#detached = false;

	reconcile(input: ConversationFeedAnnouncerInput): string | null {
		const update = this.reconcileUpdate(input);
		return update === null ? null : announcementText(update);
	}
	reconcileUpdate(input: ConversationFeedAnnouncerInput): ConversationFeedAnnouncementUpdate | null {
		const first = input.surfaceIdentity !== this.#surface;
		if (first) this.reset();
		const after = Math.max(this.#watermark, input.initialHead);
		const freshResponse = RESPONSE_CLASSES.some(key => input.responseClassOrdinals[key] > Math.max(this.#responses[key], input.initialHead));
		const previousLineages = new Set(this.#lineages);
		const chunks: string[] = [];
		for (const row of input.rows.slice(-512)) {
			const lineage = announcementLineage(row);
			const seen = lineage !== null && (previousLineages.has(lineage) || this.#lineages.has(lineage));
			const fresh = row.kind === 'local-notice' || row.ordinal === undefined
				|| row.ordinal > after && row.ordinal <= input.watermark;
			if (lineage !== null && (fresh || row.kind === 'message' && row.ordinal !== undefined && row.ordinal <= after)) this.#remember(lineage);
			if (seen || !fresh) continue;
			const text = announcementForAppendedRow(row);
			if (text) chunks.push(text);
		}
		let freshPermission = false;
		for (const id of input.floatingPermissionOccurrences) {
			const lineage = `permission:${id}`;
			if (!previousLineages.has(lineage) && !this.#lineages.has(lineage)) {
				freshPermission = true;
				chunks.push(m.chat_permission_permission_required());
			}
			this.#remember(lineage);
		}
		this.#surface = input.surfaceIdentity;
		// Head progress observed while hidden or detached must not become delayed speech.
		this.#watermark = Math.max(this.#watermark, input.watermark, input.initialHead,
			!input.visible || !input.pinnedToBottom ? input.sourceHead : 0);
		const responses = { ...this.#responses };
		for (const key of RESPONSE_CLASSES) responses[key] = Math.max(responses[key], input.responseClassOrdinals[key]);
		this.#responses = responses;
		if (first || !input.visible) { this.#detached = false; return { kind: 'clear' }; }
		if (!input.pinnedToBottom) {
			if (this.#detached || !freshResponse && !freshPermission) return null;
			this.#detached = true;
			return { kind: 'announce', chunks: [input.detachedStatus] };
		}
		const wasDetached = this.#detached;
		this.#detached = false;
		if (chunks.length) return { kind: 'announce', chunks };
		return wasDetached ? { kind: 'clear' } : null;
	}
	reset(): void {
		this.#surface = ''; this.#watermark = 0; this.#responses = emptyResponseClassOrdinals();
		this.#lineages.clear(); this.#detached = false;
	}
	#remember(id: string): void {
		this.#lineages.delete(id);
		this.#lineages.add(id);
		while (this.#lineages.size > 512) this.#lineages.delete(this.#lineages.values().next().value!);
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
