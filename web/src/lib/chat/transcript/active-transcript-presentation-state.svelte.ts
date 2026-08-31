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
	hasEarlierTranscriptRowsToReveal,
	messagesFromDisplayRows,
	transcriptDisplayRows,
	visibleOptimisticTranscriptInputs,
	visibleTranscriptRows,
	type ChatDisplayRow,
} from './transcript-row-projection.js';

export const INITIAL_VISIBLE_MESSAGES = 100;

export type ChatLoadStatus = 'idle' | 'loading' | 'loaded' | 'empty' | 'error';

export class ActiveTranscriptPresentationState {
	activeChatId = $state<string | null>(null);
	entries = $state<TranscriptMessage[]>([]);
	transcriptViewId = $state('');
	windowRevision = $state(0);
	lastOrdinal = $state(0);
	nextBeforeOrdinal = $state<number | null>(null);
	loadedThroughOrdinal = $state(0);
	hasLaterMessages = $state(false);
	visibleMessageCount = $state(INITIAL_VISIBLE_MESSAGES);
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
		this.growExpandedVisibleWindow();
		this.feedMutations.record('presentation-structure');
	});
	protected readonly feedMutations = new ConversationFeedMutationState();
	protected expandedVisibleStartOrdinal: number | null = null;

	readonly #sharedOverlay: ConversationTranscriptOverlayView | null;
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
	#visibleRows = $derived(visibleTranscriptRows({
		entries: this.entries,
		transcriptViewId: this.transcriptViewId,
		optimisticInputs: this.visibleOptimisticInputs,
		optimisticAfterOrdinals: this.optimisticAfterOrdinals,
		notices: this.#displayLocalNotices,
		visibleCount: this.visibleMessageCount,
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
		return (
			this.#sharedOverlay?.optimisticAfterOrdinals ??
			this.optimisticInputs.afterOrdinalByClientMessageId
		);
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

	get visibleRows(): ChatDisplayRow[] {
		return this.#visibleRows;
	}

	get displayMessageCount(): number {
		return this.entries.length + this.visibleOptimisticInputs.length + this.#displayLocalNotices.length;
	}

	get visibleMessages(): ChatMessage[] {
		return messagesFromDisplayRows(this.#visibleRows);
	}

	get hasEarlierRowsToReveal(): boolean {
		return hasEarlierTranscriptRowsToReveal(this.#visibleRows, this.entries);
	}

	get canLoadEarlier(): boolean {
		return this.hasEarlierRowsToReveal || this.hasEarlierMessages;
	}

	get visibleOptimisticInputs(): OptimisticUserInput[] {
		return visibleOptimisticTranscriptInputs(
			this.hasLaterMessages,
			this.optimisticUserInputs,
			this.#echoedClientMessageIds,
		);
	}

	appendLocalNotice(noticeType: LocalNoticeType, content: string): void {
		if (this.#sharedOverlay) return;
		this.notices.append(noticeType, content);
		this.growExpandedVisibleWindow();
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
		this.growExpandedVisibleWindow();
		this.feedMutations.record('presentation-structure');
	}

	clearLocalNotices(throughRevision?: number): void {
		if (this.#sharedOverlay || !this.notices.clearThrough(throughRevision)) return;
		this.growExpandedVisibleWindow();
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

	revealEarlierLoadedRows(): boolean {
		const previousCount = this.visibleMessageCount;
		const nextCount = Math.min(this.displayMessageCount, previousCount + 100);
		if (nextCount <= previousCount) return false;
		this.visibleMessageCount = nextCount;
		this.pageStates.earlier = idlePageState();
		this.rememberExpandedVisibleWindow();
		this.feedMutations.record('history-earlier');
		return true;
	}

	revealAllLoadedMessages(): void {
		const changed = this.visibleMessageCount < this.displayMessageCount;
		this.visibleMessageCount = Math.max(this.visibleMessageCount, this.displayMessageCount);
		this.rememberExpandedVisibleWindow();
		if (changed) this.feedMutations.record('initial');
	}

	protected rememberExpandedVisibleWindow(): void {
		if (this.entries.length <= INITIAL_VISIBLE_MESSAGES) return;
		let firstVisibleOrdinal: number | undefined;
		for (const row of this.#visibleRows) {
			if (row.kind !== 'message' || row.ordinal === undefined) continue;
			firstVisibleOrdinal = row.ordinal;
			break;
		}
		if (firstVisibleOrdinal === undefined) return;
		this.expandedVisibleStartOrdinal = firstVisibleOrdinal;
		this.growExpandedVisibleWindow();
	}

	protected growExpandedVisibleWindow(): void {
		if (this.expandedVisibleStartOrdinal === null) return;
		const firstVisibleIndex = this.#displayRows.findIndex(
			(row) => row.kind === 'message' && row.ordinal === this.expandedVisibleStartOrdinal,
		);
		if (firstVisibleIndex === -1) {
			this.expandedVisibleStartOrdinal = null;
			return;
		}
		this.visibleMessageCount = this.#displayRows.length - firstVisibleIndex;
	}
}
