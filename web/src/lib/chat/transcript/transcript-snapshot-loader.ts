import type { ChatTranscriptSnapshot } from './chat-transcript-cache.svelte.js';
import type { ChatMessage } from '$shared/chat-types';
import type { ChatHistoryState, ResendCandidate, TranscriptMessage, TranscriptPage } from '$shared/chat-view';
import { TRANSCRIPT_ANCHOR_TARGET } from '$shared/transcript-anchor-page';
import type { ActiveTranscriptState, ActiveTranscriptStateOptions, MessageApplyResult } from './active-transcript-state.svelte.js';
import type { ChatLoadMessagesOptions } from './active-transcript-port.js';
import type { ConversationFeedMutationKind } from './conversation-feed-mutations.js';
import { loadTranscriptAnchorSnapshot, type TranscriptAnchorSnapshot, type TranscriptAnchorSnapshotResult } from './transcript-anchor-demand.js';
import { collapseBackwardTranscriptDemand, loadTranscriptPageDemand, type TranscriptPageDemandResult } from './transcript-page-demand.js';
import { mergeTranscriptEntriesByOrdinal, retainTranscriptEntries, retainedEarlierPageCursor } from './transcript-page-progress.js';
import { responseMessageTypesAfter } from './transcript-row-projection.js';
import { transcriptSnapshotInstallMode, type TranscriptSnapshotInstallMode, type TranscriptWindowPage } from './transcript-window-loader.js';

type TranscriptSnapshotHost = Pick<ActiveTranscriptState,
	| 'abortSnapshotLoad'
	| 'activeChatId'
	| 'beginSnapshotLoad'
	| 'chatMessages'
	| 'combinedMode'
	| 'entries'
	| 'hasEarlierMessages'
	| 'hasLaterMessages'
	| 'lastOrdinal'
	| 'loadError'
	| 'loadStatus'
	| 'loadedThroughOrdinal'
	| 'nextBeforeOrdinal'
	| 'recoverTranscriptCursorAhead'
	| 'setResendCandidates'
	| 'transcriptCache'
	| 'transcriptViewId'
	| 'windowRevision'
>;

interface TranscriptSnapshotLoaderOptions {
	pageSize: number;
	isCurrentLoad(epoch: number): boolean;
	finishFailedLoad(chatId: string, epoch: number): boolean;
	installPage(chatId: string, page: TranscriptWindowPage, epoch: number,
		mode?: TranscriptSnapshotInstallMode, anchorSnapshot?: TranscriptAnchorSnapshot): MessageApplyResult | 'stale';
	onHistoryUnavailable(chatId: string, history: Exclude<ChatHistoryState, { kind: 'complete' }>): void;
	onSnapshotResendCandidates?: ActiveTranscriptStateOptions['onSnapshotResendCandidates'];
	growVisibleWindow(): void;
	resetVisibleWindow(): void;
	clearOptimisticInputs(messages?: TranscriptMessage[]): void;
	onApplied(kind: ConversationFeedMutationKind, responseMessageTypes?: readonly string[]): void;
}

export class TranscriptSnapshotLoader {
	constructor(
		private readonly host: TranscriptSnapshotHost,
		private readonly options: TranscriptSnapshotLoaderOptions,
	) {}

	installCachedSnapshot(chatId: string): MessageApplyResult | 'stale' {
		const snapshot = this.restoreCache(chatId);
		if (!snapshot || snapshot.stale) return 'stale';
		const epoch = this.host.beginSnapshotLoad();
		return this.options.installPage(
			chatId,
			{
				transcriptViewId: snapshot.transcriptViewId,
				messages: snapshot.messages,
				lastOrdinal: snapshot.lastOrdinal,
				pageOldestOrdinal: snapshot.oldestOrdinal,
				pageNewestOrdinal: snapshot.lastOrdinal,
				nextBeforeOrdinal: snapshot.nextBeforeOrdinal,
				hasMore: snapshot.nextBeforeOrdinal !== null,
			},
			epoch,
		);
	}

	restoreCache(chatId: string): ChatTranscriptSnapshot | null {
		const snapshot = this.host.transcriptCache.get(chatId);
		if (!snapshot) return this.host.transcriptCache.hydrate(chatId);
		this.host.transcriptCache.markAccessed(chatId);
		return snapshot;
	}

	installWindow(chatId: string, page: TranscriptWindowPage, mode: TranscriptSnapshotInstallMode): void {
		if (mode === 'merge') this.#mergeSnapshot(chatId, page);
		else if (mode === 'preserve-window') this.#preserveWindowFromSnapshot(chatId, page);
		else this.#replaceFromSnapshot(chatId, page);
	}

	retainWindow(messages: TranscriptMessage[], edge: 'earlier' | 'later', nextBeforeOrdinal: number | null) {
		if (this.host.combinedMode) return { retainedMessages: messages, nextBeforeOrdinal };
		const retainedMessages = retainTranscriptEntries(messages, edge);
		return {
			retainedMessages,
			nextBeforeOrdinal: retainedEarlierPageCursor(messages, retainedMessages, nextBeforeOrdinal),
		};
	}

	publishResendCandidates(
		chatId: string,
		candidates: readonly ResendCandidate[],
		frontier: { transcriptViewId: string; lastOrdinal: number },
	): void {
		if (this.options.onSnapshotResendCandidates) {
			this.options.onSnapshotResendCandidates(chatId, candidates, {
				transcriptViewId: frontier.transcriptViewId,
				lastOrdinal: frontier.lastOrdinal,
			});
			return;
		}
		this.host.setResendCandidates(candidates);
	}

	#mergeSnapshot(chatId: string, page: TranscriptWindowPage): void {
		const previousEntries = this.host.entries;
		const previousLastOrdinal = this.host.lastOrdinal;
		const previousLoadedThroughOrdinal = this.host.loadedThroughOrdinal;
		const mergedEntries = mergeTranscriptEntriesByOrdinal(previousEntries, page.messages);
		const mergedLastOrdinal = Math.max(previousLastOrdinal, page.lastOrdinal);
		const mergedLoadedThroughOrdinal = Math.max(
			previousLoadedThroughOrdinal,
			page.pageNewestOrdinal,
		);
		const pageExtendsEarlier = this.host.nextBeforeOrdinal !== null
			&& (
				page.nextBeforeOrdinal === null
				|| page.nextBeforeOrdinal <= this.host.nextBeforeOrdinal
			);
		const nextBeforeOrdinal = pageExtendsEarlier
			? page.nextBeforeOrdinal
			: this.host.nextBeforeOrdinal;
		this.#publishSnapshotCache(chatId, {
			...page,
			messages: mergedEntries,
			lastOrdinal: mergedLastOrdinal,
			pageOldestOrdinal: mergedEntries[0]?.ordinal ?? 0,
			pageNewestOrdinal: mergedLoadedThroughOrdinal,
			nextBeforeOrdinal,
			hasMore: nextBeforeOrdinal !== null,
		});
		this.host.entries = mergedEntries;
		this.host.lastOrdinal = mergedLastOrdinal;
		this.host.loadedThroughOrdinal = mergedLoadedThroughOrdinal;
		this.host.nextBeforeOrdinal = nextBeforeOrdinal;
		this.host.hasEarlierMessages = nextBeforeOrdinal !== null;
		this.host.hasLaterMessages = mergedLoadedThroughOrdinal < mergedLastOrdinal;
		this.options.growVisibleWindow();
		this.options.clearOptimisticInputs(page.messages);

		const cursorAdvanced = mergedLastOrdinal > previousLastOrdinal;
		if (mergedEntries === previousEntries && !cursorAdvanced) return;
		const preservesExistingPrefix = previousEntries.every(
			(entry, index) => mergedEntries[index] === entry,
		);
		if (preservesExistingPrefix) {
			this.options.onApplied(
				'live-append',
				responseMessageTypesAfter(page.messages, previousLastOrdinal),
			);
		} else {
			this.options.onApplied('presentation-structure');
		}
	}

	#preserveWindowFromSnapshot(chatId: string, page: TranscriptWindowPage): void {
		const previouslyHadLaterMessages = this.host.hasLaterMessages;
		this.#publishSnapshotCache(chatId, page);
		this.host.lastOrdinal = Math.max(this.host.lastOrdinal, page.lastOrdinal);
		this.host.hasLaterMessages = this.host.loadedThroughOrdinal < this.host.lastOrdinal;
		this.options.clearOptimisticInputs(page.messages);
		this.options.growVisibleWindow();
		if (this.host.hasLaterMessages !== previouslyHadLaterMessages) {
			this.options.onApplied('presentation-structure');
		}
	}

	#replaceFromSnapshot(chatId: string, page: TranscriptWindowPage): void {
		const replacesTranscriptView = this.host.transcriptViewId !== ''
			&& page.transcriptViewId !== this.host.transcriptViewId;
		this.#publishSnapshotCache(chatId, page);
		this.host.windowRevision += 1;
		if (replacesTranscriptView) {
			this.options.resetVisibleWindow();
		}
		const { retainedMessages, nextBeforeOrdinal } = this.retainWindow(
			page.messages,
			'later',
			page.nextBeforeOrdinal,
		);
		this.host.transcriptViewId = page.transcriptViewId;
		this.host.entries = retainedMessages;
		this.host.lastOrdinal = page.lastOrdinal;
		this.host.loadedThroughOrdinal = page.pageNewestOrdinal;
		this.host.nextBeforeOrdinal = nextBeforeOrdinal;
		this.host.hasEarlierMessages = nextBeforeOrdinal !== null;
		this.host.hasLaterMessages = page.pageNewestOrdinal < page.lastOrdinal;
		this.options.clearOptimisticInputs(replacesTranscriptView ? undefined : page.messages);
		this.options.onApplied('replacement');
	}

	async load(
		chatId: string,
		options: ChatLoadMessagesOptions = {},
	): Promise<ChatMessage[]> {
		if (!chatId) return [];
		const limit = Math.max(
			this.options.pageSize,
			Math.floor(options.minimumLimit ?? this.options.pageSize),
		);
		const maxAttempts = 2;

		for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
			const snapshotRead = this.host.transcriptCache.trackSnapshotRead(chatId);
			const cachedCursorAtStart = this.host.transcriptCache.readAppliedCursor(chatId);
			const cachedViewAtStart = cachedCursorAtStart?.transcriptViewId;
			const epoch = this.host.beginSnapshotLoad();
			const isCurrent = () => this.options.isCurrentLoad(epoch)
				&& snapshotRead.isCurrent()
				&& (!this.host.activeChatId || this.host.activeChatId === chatId);
			try {
				let demand: TranscriptAnchorSnapshotResult | TranscriptPageDemandResult;
				if (this.host.combinedMode) {
					const knownHeads = [{ transcriptViewId: this.host.transcriptViewId, lastOrdinal: this.host.lastOrdinal }];
					if (cachedCursorAtStart) knownHeads.push(cachedCursorAtStart);
					demand = await loadTranscriptAnchorSnapshot({
						knownHeads,
						request: {
							chatId,
							direction: 'backward',
							anchorsRemaining: TRANSCRIPT_ANCHOR_TARGET,
							...(options.purpose ? { purpose: options.purpose } : {}),
						},
						isCurrent,
						isDisjoint: (page) => transcriptSnapshotInstallMode({
							activeChatId: this.host.activeChatId,
							chatId,
							transcriptViewId: this.host.transcriptViewId,
							entryCount: this.host.entries.length,
							loadedThroughOrdinal: this.host.loadedThroughOrdinal,
							nextBeforeOrdinal: this.host.nextBeforeOrdinal,
							page,
						}) === 'preserve-window',
					});
				} else {
					demand = await loadTranscriptPageDemand({
						direction: 'backward',
						chatId,
						visibleLimit: limit,
						purpose: options.purpose,
						isCurrent,
					});
				}
				if (demand.kind === 'invalidated' || !isCurrent()) {
					this.host.abortSnapshotLoad(epoch);
					return this.host.chatMessages;
				}
				const cachedView = this.host.transcriptCache.readAppliedCursor(chatId)?.transcriptViewId;
				let responseView: string | undefined;
				if (demand.kind === 'complete') {
					responseView = 'finalChunk' in demand
						? demand.page.transcriptViewId
						: demand.pages[0]?.transcriptViewId;
				}
				// Independent snapshot owners must not restore a view replaced in the shared cache.
				if (cachedView && cachedView !== cachedViewAtStart && cachedView !== responseView) {
					this.host.abortSnapshotLoad(epoch);
					if (this.installCachedSnapshot(chatId) === 'applied') return this.host.chatMessages;
					continue;
				}
				if (demand.kind === 'unavailable') {
					if (!this.options.isCurrentLoad(epoch)) return this.host.chatMessages;
					this.options.onHistoryUnavailable(chatId, demand.response.historyState);
					return [];
				}
				if (demand.kind === 'view-changed') {
					this.host.abortSnapshotLoad(epoch);
					continue;
				}
				if (demand.kind === 'cursor-ahead') {
					await this.host.recoverTranscriptCursorAhead(chatId, demand.transcriptViewId ?? this.host.transcriptViewId);
					if (this.options.isCurrentLoad(epoch)) {
						this.host.abortSnapshotLoad(epoch);
						continue;
					}
					return this.host.chatMessages;
				}
				let page: TranscriptWindowPage;
				let anchorSnapshot: TranscriptAnchorSnapshot | undefined;
				if ('finalChunk' in demand) {
					page = demand.page;
					anchorSnapshot = demand;
				} else {
					page = collapseBackwardTranscriptDemand(demand);
				}
				const result = this.options.installPage(chatId, page, epoch, undefined, anchorSnapshot);

				if (result === 'applied' || result === 'stale') return this.host.chatMessages;

				this.host.abortSnapshotLoad(epoch);
			} catch (error) {
				if (this.options.finishFailedLoad(chatId, epoch)) {
					this.host.loadStatus = 'error';
					this.host.loadError = error instanceof Error ? error.message : 'Failed to load messages';
				}
				throw error;
			} finally {
				snapshotRead.release();
			}
		}

		this.host.loadStatus = 'error';
		this.host.loadError = 'Chat generation changed while loading messages';
		throw new Error(this.host.loadError);
	}

	#publishSnapshotCache(chatId: string, page: TranscriptPage): void {
		const current = this.host.transcriptCache.get(chatId);
		if (current && !current.stale && current.transcriptViewId === page.transcriptViewId) {
			if (current.lastOrdinal > page.pageNewestOrdinal) return;
			if (current.lastOrdinal === page.pageNewestOrdinal
				&& (current.nextBeforeOrdinal ?? 1) <= (page.nextBeforeOrdinal ?? 1)) return;
		}
		this.host.transcriptCache.replaceFromPage(chatId, page);
	}
}
