import type { ChatMessage } from '$shared/chat-types';
import type { ChatHistoryState, ResendCandidate, TranscriptMessage } from '$shared/chat-view';
import { displayLocalNotices } from './degraded-history-notice.js';
import type { LocalNoticeRow, LocalNoticeType } from './local-notice.js';
import type { OptimisticUserInput } from './optimistic-user-input.js';
import { ConversationFeedMutationState } from './ConversationFeedMutationState.svelte.js';
import type { ConversationTranscriptOverlayView } from './conversation-transcript-overlay-store.svelte.js';
import { TranscriptNoticeFeed } from './transcript-notice-feed.svelte.js';
import { TranscriptOptimisticInputs } from './transcript-optimistic-inputs.svelte.js';
import { idlePageState, type TranscriptPageDirection, type TranscriptPageState } from './transcript-page-progress.js';
import { TranscriptResendCandidates } from './transcript-resend-candidates.svelte.js';
import {
	echoedClientMessageIds,
	echoedClientMessageOrdinals,
	messagesFromDisplayRows,
	transcriptDisplayRows,
	visibleOptimisticTranscriptInputs,
	type ChatDisplayRow,
} from './transcript-row-projection.js';

export type ChatLoadStatus = 'idle' | 'loading' | 'loaded' | 'empty' | 'error';

interface PendingEcho {
	readonly input: OptimisticUserInput;
	readonly transcriptViewId: string;
	readonly ordinal: number;
	readonly afterOrdinal: number | undefined;
	readonly position: number;
}

export class ActiveTranscriptPresentationState {
	activeChatId = $state<string | null>(null);
	entries = $state.raw<TranscriptMessage[]>([]);
	transcriptViewId = $state('');
	windowRevision = $state(0);
	lastOrdinal = $state(0);
	nextBeforeOrdinal = $state<number | null>(null);
	loadedThroughOrdinal = $state(0);
	hasLaterMessages = $state(false);
	isLoadingMessages = $state(false);
	hasEarlierMessages = $state(false);
	pageStates = $state<Record<TranscriptPageDirection, TranscriptPageState>>({
		earlier: idlePageState(),
		later: idlePageState(),
	});
	isUserScrolledUp = $state(false);
	loadStatus = $state<ChatLoadStatus>('idle');
	loadError = $state<string | null>(null);
	historyState = $state<ChatHistoryState>({ kind: 'complete' });

	protected readonly resend = new TranscriptResendCandidates();
	protected readonly notices = new TranscriptNoticeFeed();
	protected readonly optimisticInputs = new TranscriptOptimisticInputs(() => {
		this.feedMutations.record('presentation-structure');
	});
	protected readonly feedMutations = new ConversationFeedMutationState();

	readonly #sharedOverlay: ConversationTranscriptOverlayView | null;
	#pendingEchoes = $state.raw<readonly PendingEcho[]>([]);
	#echoedClientMessageIds = $derived(echoedClientMessageIds(this.entries));
	#displayLocalNotices = $derived(
		displayLocalNotices(this.hasLaterMessages, this.historyState, this.localNotices),
	);
	#displayRows = $derived(transcriptDisplayRows({
		entries: this.entries,
		transcriptViewId: this.transcriptViewId,
		optimisticInputs: this.visibleOptimisticInputs,
		optimisticAfterOrdinals: this.optimisticAfterOrdinals,
		notices: this.#displayLocalNotices,
	}));

	constructor(sharedOverlay: ConversationTranscriptOverlayView | null) {
		this.#sharedOverlay = sharedOverlay;
	}

	protected get usesSharedOverlay(): boolean {
		return this.#sharedOverlay !== null;
	}

	protected get noticeRevision(): number {
		return this.#sharedOverlay?.noticeRevision ?? this.notices.revision;
	}

	private get optimisticAfterOrdinals(): ReadonlyMap<string, number> {
		const ordinals = (
			this.#sharedOverlay?.optimisticAfterOrdinals ??
			this.optimisticInputs.afterOrdinalByClientMessageId
		);
		if (this.#pendingEchoes.length === 0) return ordinals;
		const merged = new Map(ordinals);
		for (const echo of this.#pendingEchoes) {
			if (echo.afterOrdinal !== undefined) merged.set(echo.input.clientMessageId, echo.afterOrdinal);
		}
		return merged;
	}

	get localNotices(): readonly (LocalNoticeRow & { revision: number })[] {
		return this.#sharedOverlay?.notices ?? this.notices.rows;
	}

	get optimisticUserInputs(): readonly OptimisticUserInput[] {
		return this.#sharedOverlay?.optimisticInputs ?? this.optimisticInputs.rows;
	}

	get resendCandidates(): readonly ResendCandidate[] {
		return this.#sharedOverlay?.includedResendCandidates ?? this.resend.included;
	}

	get excludedResendOrdinals(): readonly number[] {
		return this.#sharedOverlay?.excludedResendOrdinals ?? this.resend.excludedOrdinals;
	}

	setResendCandidates(candidates: readonly ResendCandidate[]): void {
		if (this.#sharedOverlay) return;
		this.resend.replace(candidates);
	}

	excludeResendCandidate(ordinal: number): void {
		if (this.#sharedOverlay) return;
		this.resend.exclude(ordinal);
	}

	clearResendExclusions(): void {
		if (this.#sharedOverlay) return;
		this.resend.clearExclusions();
	}

	get chatMessages(): ChatMessage[] {
		return this.entries.map((entry) => entry.message);
	}

	get feedMutationClock() {
		return this.feedMutations.clock;
	}

	get displayMessages(): ChatMessage[] {
		return messagesFromDisplayRows(this.#displayRows);
	}

	get displayRows(): readonly ChatDisplayRow[] {
		return this.#displayRows;
	}

	get displayMessageCount(): number {
		return this.entries.length + this.visibleOptimisticInputs.length + this.#displayLocalNotices.length;
	}

	get canLoadEarlier(): boolean {
		return this.hasEarlierMessages;
	}

	get visibleOptimisticInputs(): OptimisticUserInput[] {
		const visible = visibleOptimisticTranscriptInputs(
			this.hasLaterMessages,
			this.optimisticUserInputs,
			this.#echoedClientMessageIds,
		);
		const included = new Set(visible.map((input) => input.clientMessageId));
		for (const echo of [...this.#pendingEchoes].sort((left, right) => left.position - right.position)) {
			if (this.#echoedClientMessageIds.has(echo.input.clientMessageId) || included.has(echo.input.clientMessageId)) continue;
			visible.splice(Math.min(echo.position, visible.length), 0, echo.input);
		}
		return visible;
	}

	protected retainPendingEchoes(transcriptViewId: string, messages: readonly TranscriptMessage[]): void {
		if (!this.#sharedOverlay) return;
		const ordinals = echoedClientMessageOrdinals(messages);
		const pending = [...this.#pendingEchoes];
		const retained = new Set(pending.map((echo) => echo.input.clientMessageId));
		for (const [position, input] of this.visibleOptimisticInputs.entries()) {
			const ordinal = ordinals.get(input.clientMessageId);
			if (ordinal === undefined || retained.has(input.clientMessageId)) continue;
			pending.push({ input: { ...input, delivery: 'delivered' }, ordinal, transcriptViewId, position, afterOrdinal: this.optimisticAfterOrdinals.get(input.clientMessageId) });
		}
		if (pending.length !== this.#pendingEchoes.length) this.#pendingEchoes = pending;
	}

	protected settlePendingEchoes(): void {
		const remaining = this.#pendingEchoes.filter((echo) =>
			(!this.transcriptViewId || echo.transcriptViewId === this.transcriptViewId)
			&& echo.ordinal >= (this.nextBeforeOrdinal ?? 1)
			&& !this.#echoedClientMessageIds.has(echo.input.clientMessageId),
		);
		if (remaining.length !== this.#pendingEchoes.length) {
			this.#pendingEchoes = remaining;
			this.feedMutations.record('presentation-structure');
		}
	}

	protected settlePublishedSnapshotEchoes(): void {
		this.settlePendingEchoes();
		const remaining = this.#pendingEchoes.filter((echo) => echo.ordinal <= this.loadedThroughOrdinal);
		if (remaining.length !== this.#pendingEchoes.length) {
			this.#pendingEchoes = remaining;
			this.feedMutations.record('presentation-structure');
		}
	}

	protected discardPendingEchoes(): void {
		this.#pendingEchoes = [];
	}

	appendLocalNotice(noticeType: LocalNoticeType, content: string): void {
		if (this.#sharedOverlay) return;
		this.notices.append(noticeType, content);
		this.feedMutations.record('presentation-structure');
	}

	appendServerNotice(chatId: string, noticeType: LocalNoticeType, content: string): void {
		if (this.#sharedOverlay) return;
		if (chatId === this.activeChatId) this.appendLocalNotice(noticeType, content);
		else this.notices.retain(chatId, noticeType, content);
	}

	discardServerNotices(chatId: string): void {
		if (this.#sharedOverlay) return;
		this.notices.discard(chatId);
	}

	protected drainServerNotices(chatId: string): void {
		if (this.#sharedOverlay || !this.notices.drain(chatId)) return;
		this.feedMutations.record('presentation-structure');
	}

	clearLocalNotices(throughRevision?: number): void {
		if (this.#sharedOverlay || !this.notices.clearThrough(throughRevision)) return;
		this.feedMutations.record('presentation-structure');
	}

	upsertOptimisticUserInput(input: OptimisticUserInput): void {
		if (this.#sharedOverlay) return;
		this.clearLocalNotices();
		if (this.#echoedClientMessageIds.has(input.clientMessageId)) return;
		this.optimisticInputs.upsert(input, this.lastOrdinal);
	}

	markOptimisticUserInputDelivered(clientMessageId: string): void {
		if (this.#sharedOverlay) return;
		this.optimisticInputs.markDelivered(clientMessageId);
	}

	clearOptimisticUserInput(clientMessageId: string): void {
		if (this.#sharedOverlay) return;
		this.optimisticInputs.clear(clientMessageId);
	}
}
