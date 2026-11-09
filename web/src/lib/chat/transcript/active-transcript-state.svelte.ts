import { TranscriptSnapshotLoader } from './transcript-snapshot-loader.js';
import {
	applyTranscriptAppend,
	type ChatHistoryState,
	type ResendCandidate,
	type TranscriptMessage,
	type TranscriptPage,
} from '$shared/chat-view';
import type { ChatMessage } from '$shared/chat-types';
import {
	TRANSCRIPT_ANCHOR_TARGET,
} from '$shared/transcript-anchor-page';
import {
	countTranscriptAnchors,
	loadTranscriptAnchorSnapshot,
	type TranscriptAnchorSnapshot,
} from './transcript-anchor-demand.js';
import {
	ChatTranscriptCache,
	type ChatTranscriptApplyResult,
} from './chat-transcript-cache.svelte.ts';
import type {
	ConversationTranscriptOverlayMutation,
	ConversationTranscriptOverlayView,
} from './conversation-transcript-overlay-store.svelte.js';
import type {
	ActiveTranscriptPort,
	ChatCursor,
	ChatLoadMessagesOptions,
	ChatRestoreResult,
} from './active-transcript-port.js';
import {
	retainTranscriptEntries,
	type TranscriptPageLoadResult,
	type TranscriptWindowLoadResult,
	type TranscriptWindowTarget,
} from './transcript-page-progress.js';
import { TranscriptPageLoader, type TranscriptPageLoadOptions } from './transcript-page-loader.js';
import {
	loadTranscriptRowPage,
	type TranscriptRowTarget,
	type TranscriptRowWindowResult,
} from './transcript-row-navigation.js';
import {
	loadTranscriptWindowPage,
	mergeCachedLatestAnchorWindow,
	preferCachedLatestTranscriptPage,
	transcriptSnapshotInstallMode,
	type TranscriptSnapshotInstallMode,
	type TranscriptWindowPage,
} from './transcript-window-loader.js';
import {
	TranscriptReconnectReplayState,
	type TranscriptBufferedBatch,
	type TranscriptReplayApplyResult,
} from './transcript-reconnect-replay.js';
import {
	echoedClientMessageOrdinals,
	responseMessageTypesAfter,
} from './transcript-row-projection.js';
import {
	ActiveTranscriptPresentationState,
	INITIAL_VISIBLE_MESSAGES,
} from './active-transcript-presentation-state.svelte.js';
export type {
	ActiveTranscriptPort,
	ChatCursor,
	ChatLoadMessagesOptions,
	ChatRestoreResult,
} from './active-transcript-port.js';
export type { ChatDisplayRow, ChatTranscriptRow } from './transcript-row-projection.js';
export { INITIAL_VISIBLE_MESSAGES } from './active-transcript-presentation-state.svelte.js';
export type { ChatLoadStatus } from './active-transcript-presentation-state.svelte.js';

const MESSAGES_PER_PAGE = 50;
export type MessageApplyResult = TranscriptReplayApplyResult;
type PageApplyResult = MessageApplyResult | 'stale';

export interface ActiveTranscriptStateOptions {
	combineMessages?: boolean;
	recoverTranscript?: (chatId: string, transcriptViewId: string) => Promise<void>;
	onSnapshotResendCandidates?: (
		chatId: string,
		candidates: readonly ResendCandidate[],
		frontier: { transcriptViewId: string; lastOrdinal: number },
	) => void;
}

export interface SharedTranscriptCommit {
	readonly chatId: string;
	readonly transcriptViewId: string;
	readonly messages: TranscriptMessage[];
	readonly firstOrdinal: number;
	readonly lastOrdinal: number;
	readonly resendCandidates: ResendCandidate[];
	readonly noticeRevision: number;
	readonly outcome: Extract<ChatTranscriptApplyResult, { status: 'applied' }>;
	readonly overlayMutation: ConversationTranscriptOverlayMutation;
}

export class ActiveTranscriptState extends ActiveTranscriptPresentationState implements ActiveTranscriptPort {
	readonly transcriptCache: ChatTranscriptCache;
	pagingRevision = $state(0);
	#commitBuffer: { owner: 'snapshot' | number; batches: TranscriptBufferedBatch[] } | null = null;
	#reconnectReplay = new TranscriptReconnectReplayState((chatId, batch) => this.#replayBatch(chatId, batch));
	#loadEpoch = 0;
	#windowNavigationEpoch = 0;
	#activeWindowNavigationEpoch: number | null = null;
	#windowSelectionRevision = 0;
	#pageLoader: TranscriptPageLoader;
	#snapshots: TranscriptSnapshotLoader;

	constructor(
		transcriptCache = new ChatTranscriptCache({ limit: INITIAL_VISIBLE_MESSAGES }),
		sharedOverlay: ConversationTranscriptOverlayView | null = null,
		private readonly options: ActiveTranscriptStateOptions = {},
	) {
		super(sharedOverlay, options.combineMessages);
		this.transcriptCache = transcriptCache;
		this.#pageLoader = new TranscriptPageLoader(this, {
			pageSize: MESSAGES_PER_PAGE,
			onDemandSeeded: () => { this.pagingRevision += 1; },
			onHistoryUnavailable: (chatId, historyState) => {
				this.#setUnavailableHistory(chatId, historyState);
			},
			onPageApplied: (direction) => {
				this.rememberExpandedVisibleWindow();
				this.feedMutations.record(
					direction === 'earlier' ? 'history-earlier' : 'history-later',
				);
			},
			onEarlierPageProgress: (chatId, requestBeforeOrdinal, page) => {
				this.transcriptCache.applyEarlierPage(
					chatId,
					page.transcriptViewId,
					requestBeforeOrdinal,
					page,
				);
			},
		});
		this.#snapshots = new TranscriptSnapshotLoader(this, {
			pageSize: MESSAGES_PER_PAGE,
			isCurrentLoad: epoch => epoch === this.#loadEpoch,
			finishFailedLoad: (chatId, epoch) => this.#finishFailedSnapshotLoad(chatId, epoch),
			installPage: (chatId, page, epoch, mode, snapshot) => this.#installSnapshotPage(chatId, page, epoch, mode, snapshot),
			onHistoryUnavailable: (chatId, history) => this.#setUnavailableHistory(chatId, history),
			onSnapshotResendCandidates: options.onSnapshotResendCandidates,
			growVisibleWindow: () => this.growExpandedVisibleWindow(),
			resetVisibleWindow: () => {
				this.expandedVisibleStartOrdinal = null;
				this.visibleMessageCount = Math.min(this.visibleMessageCount, INITIAL_VISIBLE_MESSAGES);
			},
			clearOptimisticInputs: messages => {
				if (this.usesSharedOverlay) return;
				if (messages) this.optimisticInputs.clearEchoed(echoedClientMessageOrdinals(messages));
				else this.optimisticInputs.clearAll();
			},
			onApplied: (kind, types) => this.feedMutations.record(kind, types),
		});
	}

	hasPendingAnchorDemand(direction: 'earlier' | 'later'): boolean {
		void this.pagingRevision;
		return this.combinedMode && this.#pageLoader.hasPending(direction);
	}

	isPageLoading(direction: 'earlier' | 'later'): boolean {
		return this.#pageLoader.isLoading(direction);
	}

	async recoverTranscriptCursorAhead(chatId: string, transcriptViewId: string): Promise<void> {
		if (this.options.recoverTranscript) {
			await this.options.recoverTranscript(chatId, transcriptViewId);
			return;
		}
		if (this.activeChatId !== chatId || this.transcriptViewId !== transcriptViewId) return;
		this.transcriptCache.remove(chatId);
		this.clearMessages();
		await this.loadMessages(chatId);
	}

	getCursor(): ChatCursor {
		const cached = this.activeChatId
			? this.transcriptCache.readAppliedCursor(this.activeChatId)
			: null;
		const lastOrdinal = cached
			&& !cached.stale
			&& cached.transcriptViewId === this.transcriptViewId
			? Math.min(cached.lastOrdinal, this.lastOrdinal)
			: Math.min(this.loadedThroughOrdinal, this.lastOrdinal);
		return { transcriptViewId: this.transcriptViewId, lastOrdinal };
	}

	beginReconnectReplay(chatId: string, transcriptViewId: string): number {
		return this.#reconnectReplay.begin(chatId, transcriptViewId);
	}

	applyReconnectReplayPage(
		token: number,
		chatId: string,
		transcriptViewId: string,
		messages: TranscriptMessage[],
		firstOrdinal: number,
		lastOrdinal: number,
		resendCandidates: ResendCandidate[],
	): MessageApplyResult | 'stale' {
		return this.#reconnectReplay.applyPage(token, chatId, {
			transcriptViewId,
			messages,
			firstOrdinal,
			lastOrdinal,
			resendCandidates,
			noticeRevision: this.noticeRevision,
		});
	}

	finishReconnectReplay(token: number, chatId: string): MessageApplyResult | 'stale' {
		return this.#reconnectReplay.finish(token, chatId);
	}

	abortReconnectReplay(token: number): void {
		this.#reconnectReplay.abort(token);
	}

	applyMessages(
		chatId: string,
		transcriptViewId: string,
		messages: TranscriptMessage[],
		firstOrdinal: number,
		lastOrdinal: number,
		resendCandidates: ResendCandidate[] = [...this.resendCandidates],
		noticeRevision = this.noticeRevision,
	): MessageApplyResult {
		if (this.historyState.kind !== 'complete') {
			this.transcriptCache.markStale(chatId);
			return 'gap-detected';
		}
		const append = { firstOrdinal, lastOrdinal, messages };
		const bufferedBatch = { transcriptViewId, ...append, noticeRevision, resendCandidates };
		if (this.#commitBuffer) {
			this.transcriptCache.applyMessages(chatId, transcriptViewId, append);
			this.#commitBuffer.batches.push(bufferedBatch);
			return 'applied';
		}
		if (this.#reconnectReplay.buffer(chatId, bufferedBatch)) {
			return 'applied';
		}
		if (this.transcriptViewId && transcriptViewId !== this.transcriptViewId) {
			this.#invalidatePageLoad();
			this.transcriptCache.markStale(chatId);
			return 'view-changed';
		}
		const result = this.transcriptCache.applyMessages(chatId, transcriptViewId, append);
		return this.#applyCommittedAppend(
			chatId,
			transcriptViewId,
			messages,
			firstOrdinal,
			lastOrdinal,
			resendCandidates,
			noticeRevision,
			result,
		);
	}

	applySharedCommit(commit: SharedTranscriptCommit): MessageApplyResult {
		const {
			chatId,
			transcriptViewId,
			messages,
			firstOrdinal,
			lastOrdinal,
			resendCandidates,
			noticeRevision,
			outcome,
		} = commit;
		if (this.historyState.kind !== 'complete') return 'gap-detected';
		const bufferedBatch = {
			transcriptViewId,
			messages,
			firstOrdinal,
			lastOrdinal,
			noticeRevision,
			resendCandidates,
		};
		if (this.#commitBuffer) {
			this.#commitBuffer.batches.push(bufferedBatch);
			return 'applied';
		}
		if (this.#reconnectReplay.buffer(chatId, bufferedBatch)) return 'applied';
		if (this.transcriptViewId && transcriptViewId !== this.transcriptViewId) {
			this.#invalidatePageLoad();
			return 'view-changed';
		}
		return this.#applyCommittedAppend(
			chatId,
			transcriptViewId,
			messages,
			firstOrdinal,
			lastOrdinal,
			resendCandidates,
			noticeRevision,
			outcome,
		);
	}

	applySharedOverlayMutation(mutation: ConversationTranscriptOverlayMutation): void {
		if (!mutation.feedStructureChanged) return;
		this.growExpandedVisibleWindow();
		this.feedMutations.record('presentation-structure');
	}

	#applyCommittedAppend(
		chatId: string,
		transcriptViewId: string,
		messages: TranscriptMessage[],
		firstOrdinal: number,
		lastOrdinal: number,
		resendCandidates: ResendCandidate[],
		noticeRevision: number,
		result: ChatTranscriptApplyResult,
	): MessageApplyResult {
		if (result.status === 'view-changed') {
			this.#invalidatePageLoad();
			this.transcriptCache.markStale(chatId);
			return 'view-changed';
		}
		if (result.status !== 'applied') {
			const gapDetails =
				result.status === 'gap-detected'
					? ` expected=${result.expectedOrdinal} received=${result.receivedOrdinal}`
					: '';
			console.warn(
				`[chat-state] transcript apply failed chat=${chatId} generation=${transcriptViewId} status=${result.status}${gapDetails}`,
			);
			return 'gap-detected';
		}
		const appliedFrontierOrdinal = Math.min(this.loadedThroughOrdinal, this.lastOrdinal);
		const append = { firstOrdinal, lastOrdinal, messages };
		const responseMessageTypes = responseMessageTypesAfter(messages, appliedFrontierOrdinal);
		const observedHeadAdvanced = result.lastOrdinal > this.lastOrdinal;
		this.lastOrdinal = Math.max(this.lastOrdinal, result.lastOrdinal);
		if (this.hasLaterMessages && firstOrdinal > appliedFrontierOrdinal + 1) {
			const cacheStateChanged = result.changed || observedHeadAdvanced;
			this.transcriptViewId = transcriptViewId;
			if (cacheStateChanged) {
				this.clearLocalNotices(noticeRevision);
			}
			if (this.entries.length > 0 && this.loadStatus !== 'error') {
				this.loadStatus = 'loaded';
			}
			if (cacheStateChanged) {
				this.feedMutations.record('live-append', responseMessageTypes);
			}
			if (!this.usesSharedOverlay) {
				this.optimisticInputs.clearEchoed(echoedClientMessageOrdinals(messages));
			}
			this.setResendCandidates(resendCandidates);
			return 'applied';
		}
		const previousEntryCount = this.entries.length;
		const applied = applyTranscriptAppend(this.entries, append, appliedFrontierOrdinal);
		let entriesChanged = applied.status === 'applied' && applied.changed;
		if (applied.status === 'applied') {
			this.transcriptViewId = transcriptViewId;
			if (applied.messages !== this.entries) this.entries = applied.messages;
			this.loadedThroughOrdinal = applied.lastOrdinal;
			this.hasLaterMessages = this.loadedThroughOrdinal < this.lastOrdinal;
			if (entriesChanged && this.isUserScrolledUp && !this.combinedMode) {
				const appendedCount = Math.max(0, this.entries.length - previousEntryCount);
				this.visibleMessageCount = Math.min(
					this.displayMessageCount,
					this.visibleMessageCount + appendedCount,
				);
			}
		} else {
			const restored = this.#snapshots.restoreCache(chatId);
			if (!restored || restored.transcriptViewId !== transcriptViewId) return 'gap-detected';
			this.#invalidatePageLoad();
			entriesChanged = true;
			this.transcriptViewId = restored.transcriptViewId;
			this.entries = retainTranscriptEntries(restored.messages, 'later');
			this.lastOrdinal = restored.lastOrdinal;
			this.loadedThroughOrdinal = restored.lastOrdinal;
			this.nextBeforeOrdinal = restored.nextBeforeOrdinal;
			this.hasEarlierMessages = restored.nextBeforeOrdinal !== null;
			this.hasLaterMessages = false;
			this.#pageLoader.seedRestoredAnchorTarget(chatId);
		}
		if (entriesChanged) {
			this.clearLocalNotices(noticeRevision);
		}
		if (entriesChanged) this.growExpandedVisibleWindow();
		if (this.entries.length > 0 && this.loadStatus !== 'error') {
			this.loadStatus = 'loaded';
		}
		if (entriesChanged) {
			this.feedMutations.record('live-append', responseMessageTypes);
		}
		if (!this.usesSharedOverlay) {
			this.optimisticInputs.clearEchoed(echoedClientMessageOrdinals(messages));
		}
		this.setResendCandidates(resendCandidates);
		return 'applied';
	}

	beginSnapshotLoad(): number {
		const epoch = this.#beginLoadEpoch();
		this.#commitBuffer = { owner: 'snapshot', batches: this.#commitBuffer?.batches ?? [] };
		this.isLoadingMessages = true;
		this.loadStatus = 'loading';
		this.loadError = null;
		return epoch;
	}

	abortSnapshotLoad(epoch: number): void {
		if (epoch !== this.#loadEpoch) return;
		this.#commitBuffer = null;
		this.isLoadingMessages = false;
	}

	#finishFailedSnapshotLoad(chatId: string, epoch: number): boolean {
		if (epoch !== this.#loadEpoch) return false;
		if (this.activeChatId && this.activeChatId !== chatId) {
			this.abortSnapshotLoad(epoch);
			return false;
		}

		const buffered = this.#takeBufferedBatches();
		this.isLoadingMessages = false;
		this.#replayBufferedBatches(chatId, buffered);
		return true;
	}

	#takeBufferedBatches(): TranscriptBufferedBatch[] {
		const buffered = this.#commitBuffer?.batches ?? [];
		this.#commitBuffer = null;
		return buffered;
	}

	#replayBatch(chatId: string, batch: TranscriptBufferedBatch): MessageApplyResult {
		return this.applyMessages(
			chatId,
			batch.transcriptViewId,
			batch.messages,
			batch.firstOrdinal,
			batch.lastOrdinal,
			batch.resendCandidates,
			batch.noticeRevision,
		);
	}

	#replayBufferedBatches(chatId: string, buffered: readonly TranscriptBufferedBatch[]): MessageApplyResult {
		for (const batch of buffered) {
			const result = this.#replayBatch(chatId, batch);
			if (result !== 'applied') return result;
		}
		return 'applied';
	}

	replaceGeneration(
		chatId: string,
		transcriptViewId: string,
		messages: TranscriptMessage[],
		options: Pick<
			TranscriptPage,
			'lastOrdinal' | 'pageOldestOrdinal' | 'nextBeforeOrdinal' | 'hasMore'
		> & {
			pageNewestOrdinal?: number;
			resendCandidates?: ResendCandidate[];
		},
	): void {
		const { retainedMessages, nextBeforeOrdinal } = this.#snapshots.retainWindow(
			messages,
			'later',
			options.nextBeforeOrdinal,
		);
		const pageNewestOrdinal = options.pageNewestOrdinal ?? options.lastOrdinal;
		this.#invalidatePageLoad();
		this.expandedVisibleStartOrdinal = null;
		this.historyState = { kind: 'complete' };
		this.activeChatId = chatId;
		this.#loadEpoch += 1;
		this.#commitBuffer = null;
		this.#reconnectReplay.reset();
		this.transcriptCache.replaceFromPage(chatId, {
			transcriptViewId,
			messages,
			lastOrdinal: options.lastOrdinal,
			pageOldestOrdinal: options.pageOldestOrdinal,
			pageNewestOrdinal,
			nextBeforeOrdinal: options.nextBeforeOrdinal,
			hasMore: options.hasMore,
		});
		this.windowRevision += 1;
		this.#windowSelectionRevision += 1;
		this.transcriptViewId = transcriptViewId;
		this.entries = retainedMessages;
		this.lastOrdinal = options.lastOrdinal;
		this.loadedThroughOrdinal = pageNewestOrdinal;
		this.nextBeforeOrdinal = nextBeforeOrdinal;
		this.hasEarlierMessages = nextBeforeOrdinal !== null;
		this.hasLaterMessages = pageNewestOrdinal < options.lastOrdinal;
		if (!this.usesSharedOverlay) this.optimisticInputs.clearAll();
		this.#snapshots.publishResendCandidates(chatId, options.resendCandidates ?? [], { transcriptViewId, lastOrdinal: options.lastOrdinal });
		this.visibleMessageCount = INITIAL_VISIBLE_MESSAGES;
		if (!this.usesSharedOverlay) this.notices.reset();
		this.loadStatus = messages.length === 0 ? 'empty' : 'loaded';
		this.loadError = null;
		this.isLoadingMessages = false;
		this.feedMutations.record('replacement');
	}

	setFromPage(
		chatId: string,
		page: TranscriptWindowPage,
		epoch: number,
	): PageApplyResult {
		return this.#installSnapshotPage(chatId, page, epoch);
	}

	installCachedSnapshot(chatId: string): PageApplyResult {
		return this.#snapshots.installCachedSnapshot(chatId);
	}

	snapshotHandoffGuard(): () => boolean {
		// Snapshot publication preserves the selection; committed navigation and resets retire it.
		const selectionRevision = this.#windowSelectionRevision;
		return () => this.#windowSelectionRevision === selectionRevision
			&& this.#activeWindowNavigationEpoch !== this.#windowNavigationEpoch;
	}

	#installSnapshotPage(
		chatId: string,
		page: TranscriptWindowPage,
		epoch: number,
		requiredInstallMode?: TranscriptSnapshotInstallMode,
		anchorSnapshot?: TranscriptAnchorSnapshot,
	): PageApplyResult {
		if (epoch !== this.#loadEpoch) return 'stale';

		const buffered = this.#takeBufferedBatches();
		const hasBufferedGenerationChange = buffered.some(
			(batch) => batch.transcriptViewId !== page.transcriptViewId,
		);
		if (hasBufferedGenerationChange) {
			this.#invalidatePageLoad();
			this.isLoadingMessages = false;
			return 'view-changed';
		}

		this.#reconnectReplay.reset();
		this.invalidatePendingHistoryLoad();
		this.historyState = { kind: 'complete' };
		const installMode = requiredInstallMode ?? transcriptSnapshotInstallMode({
			activeChatId: this.activeChatId,
			chatId,
			transcriptViewId: this.transcriptViewId,
			entryCount: this.entries.length,
			loadedThroughOrdinal: this.loadedThroughOrdinal,
			nextBeforeOrdinal: this.nextBeforeOrdinal,
			page,
		});
		const olderAnchors = this.transcriptViewId === page.transcriptViewId
			? countTranscriptAnchors(this.entries, page.nextBeforeOrdinal ?? 1) : 0;
		if (installMode === 'replace') this.#invalidatePageLoad();
		this.#snapshots.installWindow(chatId, page, installMode);
		if (requiredInstallMode === 'replace') this.#windowSelectionRevision += 1;
		if (page.resendCandidates !== undefined) {
			this.#snapshots.publishResendCandidates(chatId, page.resendCandidates, anchorSnapshot?.page ?? page);
		}
		if (this.combinedMode) {
			if (installMode === 'preserve-window') this.#pageLoader.seed('earlier', null);
			else if (anchorSnapshot) this.#pageLoader.seedAnchorSnapshot(chatId, anchorSnapshot, olderAnchors);
			else this.#pageLoader.seedRestoredAnchorTarget(chatId);
		}
		if (!this.usesSharedOverlay) this.clearLocalNotices(this.notices.revisionAtLoadStart);
		this.loadStatus = this.entries.length === 0 ? 'empty' : 'loaded';
		this.loadError = null;
		this.isLoadingMessages = false;
		return this.#replayBufferedBatches(chatId, buffered);
	}

	loadMessages(chatId: string, options: ChatLoadMessagesOptions = {}): Promise<ChatMessage[]> {
		return this.#snapshots.load(chatId, options);
	}

	async loadEarlierPage(
		chatId: string,
		options?: TranscriptPageLoadOptions,
	): Promise<TranscriptPageLoadResult> {
		return this.#pageLoader.load('earlier', chatId, options);
	}

	async loadLaterPage(
		chatId: string,
		options?: TranscriptPageLoadOptions,
	): Promise<TranscriptPageLoadResult> {
		return this.#pageLoader.load('later', chatId, options);
	}

	invalidatePendingHistoryLoad(): void {
		if (this.combinedMode) this.#pageLoader.suspend();
		else this.#pageLoader.invalidate();
	}

	invalidatePendingWindowNavigation(): void {
		this.#windowNavigationEpoch += 1;
		if (typeof this.#commitBuffer?.owner === 'number') this.#drainNavigationBuffer(this.#commitBuffer.owner);
	}

	suspendForParking(): boolean {
		const chatId = this.activeChatId;
		if (!chatId || !this.transcriptViewId || this.entries.length === 0) return false;
		const cached = this.transcriptCache.readAppliedCursor(chatId);
		if (!cached || cached.stale || cached.transcriptViewId !== this.transcriptViewId) {
			return false;
		}

		this.#loadEpoch += 1;
		this.#windowNavigationEpoch += 1;
		this.#pageLoader.suspend();
		const buffered = this.#takeBufferedBatches();
		this.isLoadingMessages = false;
		for (const batch of buffered) {
			if (batch.transcriptViewId !== this.transcriptViewId) return false;
			const result = this.#applyCommittedAppend(
				chatId,
				batch.transcriptViewId,
				batch.messages,
				batch.firstOrdinal,
				batch.lastOrdinal,
				batch.resendCandidates,
				batch.noticeRevision,
				{ status: 'applied', changed: true, lastOrdinal: batch.lastOrdinal },
			);
			if (result !== 'applied') return false;
		}
		this.loadStatus = 'loaded';
		return this.lastOrdinal === cached.lastOrdinal;
	}

	#invalidatePageLoad(): void {
		this.#pageLoader.invalidate();
	}

	clearMessages(): void {
		this.#resetToEmptyTranscript();
		this.loadStatus = 'idle';
		this.historyState = { kind: 'complete' };
		this.feedMutations.record('replacement');
	}

	invalidatePendingLoads(): void {
		this.#invalidatePageLoad();
		this.#loadEpoch += 1;
		this.#windowNavigationEpoch += 1;
		this.#commitBuffer = null;
		this.#reconnectReplay.reset();
		this.isLoadingMessages = false;
	}

	#resetToEmptyTranscript(): void {
		this.invalidatePendingLoads();
		this.expandedVisibleStartOrdinal = null;
		this.windowRevision += 1;
		this.#windowSelectionRevision += 1;
		this.entries = [];
		this.transcriptViewId = '';
		this.lastOrdinal = 0;
		this.nextBeforeOrdinal = null;
		this.loadedThroughOrdinal = 0;
		if (!this.usesSharedOverlay) {
			this.optimisticInputs.clearAll();
			this.resend.clear();
			this.notices.reset();
		}
		this.hasEarlierMessages = false;
		this.hasLaterMessages = false;
		this.loadError = null;
	}

	async navigateToWindow(
		chatId: string,
		target: TranscriptWindowTarget,
	): Promise<TranscriptWindowLoadResult> {
		if (!chatId || this.activeChatId !== chatId) return 'invalidated';
		this.invalidatePendingWindowNavigation();
		if (this.#commitBuffer?.owner === 'snapshot') return 'invalidated';
		const alreadyAtTarget = target === 'latest'
			? !this.hasLaterMessages
			: !this.hasEarlierMessages;

		const windowNavigationEpoch = ++this.#windowNavigationEpoch;
		const loadEpoch = this.#beginLoadEpoch();
		this.#invalidatePageLoad();
		this.isLoadingMessages = false;
		if (alreadyAtTarget) {
			this.#pageLoader.seedRestoredAnchorTarget(chatId);
			return 'loaded';
		}

		const transcriptViewId = this.transcriptViewId;
		const latestLastOrdinal = this.lastOrdinal;
		this.#activeWindowNavigationEpoch = windowNavigationEpoch;
		try {
			if (this.combinedMode) {
				return await this.#navigateToAnchorWindow(chatId, target, transcriptViewId, loadEpoch, windowNavigationEpoch);
			}
			const isCurrent = () => (
				windowNavigationEpoch === this.#windowNavigationEpoch
				&& loadEpoch === this.#loadEpoch
				&& this.activeChatId === chatId
				&& this.transcriptViewId === transcriptViewId
			);
			const result = await loadTranscriptWindowPage({
				chatId,
				target,
				transcriptViewId,
				lastOrdinal: latestLastOrdinal,
				visibleLimit: MESSAGES_PER_PAGE,
				isCurrent,
			});
			if (result.kind === 'invalidated') return 'invalidated';
			if (result.kind === 'unavailable') {
				this.#setUnavailableHistory(chatId, result.response.historyState);
				return 'loaded';
			}
			if (result.kind === 'view-changed') {
				this.transcriptCache.markStale(chatId);
				return 'invalidated';
			}
			const page = result.page;

			if (target === 'latest') {
				const latestPage = preferCachedLatestTranscriptPage(
					page,
					this.#snapshots.restoreCache(chatId),
					this.resendCandidates,
				);
				return this.#installSnapshotPage(chatId, latestPage, loadEpoch, 'replace') === 'applied'
					? 'loaded'
					: 'invalidated';
			}

			this.#replaceWindowPage(page);
			return 'loaded';
		} catch (error) {
			if (
				windowNavigationEpoch !== this.#windowNavigationEpoch ||
				loadEpoch !== this.#loadEpoch ||
				this.activeChatId !== chatId ||
				this.transcriptViewId !== transcriptViewId
			) {
				return 'invalidated';
			}
			console.error(`Error loading ${target} messages:`, error);
			return 'failed';
		} finally {
			if (this.#activeWindowNavigationEpoch === windowNavigationEpoch) {
				this.#activeWindowNavigationEpoch = null;
			}
		}
	}

	async #navigateToAnchorWindow(
		chatId: string,
		target: TranscriptWindowTarget,
		transcriptViewId: string,
		loadEpoch: number,
		windowEpoch: number,
	): Promise<TranscriptWindowLoadResult> {
		this.#commitBuffer = { owner: windowEpoch, batches: [] };
		const read = this.transcriptCache.trackSnapshotRead(chatId);
		const isCurrent = () => windowEpoch === this.#windowNavigationEpoch && loadEpoch === this.#loadEpoch
			&& this.activeChatId === chatId && this.transcriptViewId === transcriptViewId && read.isCurrent();
		try {
			const result = await loadTranscriptAnchorSnapshot({
				request: { chatId, transcriptViewId, direction: target === 'latest' ? 'backward' : 'forward',
					anchorsRemaining: TRANSCRIPT_ANCHOR_TARGET },
				isCurrent,
			});
			if (result.kind === 'invalidated') return 'invalidated';
			if (result.kind === 'view-changed' || result.kind === 'cursor-ahead') {
				await this.recoverTranscriptCursorAhead(chatId, transcriptViewId);
				return 'invalidated';
			}
			if (result.kind === 'unavailable') {
				this.#setUnavailableHistory(chatId, result.response.historyState);
				return 'loaded';
			}
			if (target === 'latest') {
				const latest = mergeCachedLatestAnchorWindow(result.page, this.#snapshots.restoreCache(chatId));
				const applied = this.#installSnapshotPage(chatId, latest, loadEpoch, 'replace', result);
				if (applied === 'view-changed' || applied === 'gap-detected') {
					void this.loadMessages(chatId).catch(() => {});
				}
				return applied === 'applied' ? 'loaded' : 'invalidated';
			}
			this.#replaceWindowPage(result.page);
			this.#pageLoader.seedAnchorSnapshot(chatId, result);
			return 'loaded';
		} catch (error) {
			if (!isCurrent()) return 'invalidated';
			console.error(`Error loading ${target} messages:`, error);
			return 'failed';
		} finally {
			read.release();
			this.#drainNavigationBuffer(windowEpoch);
		}
	}

	#drainNavigationBuffer(owner: number): void {
		if (this.#commitBuffer?.owner !== owner) return;
		const buffered = this.#takeBufferedBatches();
		const chatId = this.activeChatId;
		if (!chatId) return;
		if (this.#replayBufferedBatches(chatId, buffered) !== 'applied') {
			void this.loadMessages(chatId).catch(() => {});
		}
	}

	async navigateToRow(
		target: TranscriptRowTarget,
		signal: AbortSignal,
		ownsNavigation: () => boolean,
	): Promise<TranscriptRowWindowResult> {
		if (signal.aborted || !ownsNavigation() || this.activeChatId !== target.chatId)
			return 'cancelled';
		if (!this.transcriptViewId) throw new Error('Transcript has not loaded');
		if (this.transcriptViewId !== target.transcriptViewId) return 'view-changed';
		this.invalidatePendingWindowNavigation();
		if (this.#commitBuffer?.owner === 'snapshot') return 'unavailable';
		const windowEpoch = ++this.#windowNavigationEpoch;
		const loadEpoch = this.#beginLoadEpoch();
		this.#invalidatePageLoad();
		const ownsWindow = () =>
			!signal.aborted &&
			ownsNavigation() &&
			this.activeChatId === target.chatId &&
			windowEpoch === this.#windowNavigationEpoch;
		this.#activeWindowNavigationEpoch = windowEpoch;
		try {
			const result = await loadTranscriptRowPage(target, signal);
			if (!ownsWindow()) return 'cancelled';
			if (loadEpoch !== this.#loadEpoch) return 'unavailable';
			if (this.transcriptViewId !== target.transcriptViewId || result.kind === 'view-changed')
				return 'view-changed';
			if (result.kind !== 'loaded') return result.kind;
			this.#replaceWindowPage({
				...result.page,
				lastOrdinal: Math.max(this.lastOrdinal, result.page.lastOrdinal),
			});
			return 'loaded';
		} finally {
			if (this.#activeWindowNavigationEpoch === windowEpoch) this.#activeWindowNavigationEpoch = null;
		}
	}

	#replaceWindowPage(page: TranscriptPage): void {
		this.expandedVisibleStartOrdinal = null;
		this.windowRevision += 1;
		this.#windowSelectionRevision += 1;
		const { retainedMessages, nextBeforeOrdinal } = this.#snapshots.retainWindow(
			page.messages,
			'earlier',
			page.nextBeforeOrdinal,
		);
		this.entries = retainedMessages;
		this.lastOrdinal = page.lastOrdinal;
		this.nextBeforeOrdinal = nextBeforeOrdinal;
		this.loadedThroughOrdinal = page.pageNewestOrdinal;
		this.hasEarlierMessages = nextBeforeOrdinal !== null;
		this.hasLaterMessages = page.pageNewestOrdinal < page.lastOrdinal;
		if (!this.combinedMode) this.visibleMessageCount = retainedMessages.length;
		if (this.hasLaterMessages) this.isUserScrolledUp = true;
		this.loadStatus = page.messages.length === 0 ? 'empty' : 'loaded';
		this.loadError = null;
		this.feedMutations.record('replacement');
	}

	#beginLoadEpoch(): number {
		if (!this.usesSharedOverlay) this.notices.markLoadStart();
		return ++this.#loadEpoch;
	}

	resetForNewChat(): void {
		this.clearMessages();
		this.visibleMessageCount = INITIAL_VISIBLE_MESSAGES;
		this.isUserScrolledUp = false;
	}

	#setUnavailableHistory(
		chatId: string,
		historyState: Exclude<ChatHistoryState, { kind: 'complete' }>,
	): void {
		this.activeChatId = chatId;
		this.transcriptCache.remove(chatId);
		this.#resetToEmptyTranscript();
		this.visibleMessageCount = INITIAL_VISIBLE_MESSAGES;
		this.loadStatus = 'loaded';
		this.historyState = historyState;
		this.feedMutations.record('replacement');
	}

	activateChat(chatId: string | null): ChatRestoreResult | null {
		this.activeChatId = chatId;
		this.resetForNewChat();
		if (!chatId) return null;
		this.drainServerNotices(chatId);
		// Publishes the bounded cache window atomically; the virtual feed limits mounted row work.
		const restored = this.#snapshots.restoreCache(chatId);
		if (!restored) return null;
		const retainedMessages = retainTranscriptEntries(restored.messages, 'later');
		this.entries = retainedMessages;
		this.transcriptViewId = restored.transcriptViewId;
		this.lastOrdinal = restored.lastOrdinal;
		this.loadedThroughOrdinal = restored.lastOrdinal;
		this.nextBeforeOrdinal = restored.nextBeforeOrdinal;
		// Preserves the earlier boundary across cache restore so validation cannot insert it after paint.
		this.hasEarlierMessages = restored.nextBeforeOrdinal !== null;
		this.hasLaterMessages = false;
		this.loadStatus = retainedMessages.length === 0 ? 'empty' : 'loaded';
		if (!restored.stale) this.#pageLoader.seedRestoredAnchorTarget(chatId);
		return { count: retainedMessages.length, stale: restored.stale };
	}

	removeCachedMessages(chatId: string): void {
		this.transcriptCache.remove(chatId);
	}

}
