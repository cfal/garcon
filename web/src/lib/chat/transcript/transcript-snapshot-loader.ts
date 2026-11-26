import type { ChatTranscriptSnapshot, TranscriptViewLease } from './chat-transcript-cache.svelte.js';
import type { TranscriptHeadResult } from './transcript-head-coordinator.js';
import type { ChatHistoryState, ResendCandidate, TranscriptMessage, TranscriptPage } from '$shared/chat-view';
import type { ActiveTranscriptState, ActiveTranscriptStateOptions, PageApplyResult } from './active-transcript-state.svelte.js';
import type { ChatLoadMessagesOptions } from './active-transcript-port.js';
import type { ConversationFeedMutationKind } from './conversation-feed-mutations.js';
import type { TranscriptAnchorSnapshot } from './transcript-anchor-demand.js';
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
	| 'setResendCandidates'
	| 'transcriptCache'
	| 'transcriptViewId'
	| 'windowRevision'
>;

interface TranscriptSnapshotLoaderOptions {
	isCurrentLoad(epoch: number): boolean;
	finishFailedLoad(chatId: string, epoch: number): boolean;
	installPage(chatId: string, page: TranscriptWindowPage, epoch: number,
		mode?: TranscriptSnapshotInstallMode, anchorSnapshot?: TranscriptAnchorSnapshot, lease?: TranscriptViewLease): PageApplyResult;
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

	installCachedSnapshot(chatId: string, lease?: TranscriptViewLease): PageApplyResult {
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
			undefined,
			undefined,
			lease,
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

	async load(chatId: string, options: ChatLoadMessagesOptions = {}): Promise<TranscriptHeadResult> {
		if (!chatId) return { kind: 'invalidated' };
		const epoch = this.host.beginSnapshotLoad();
		const lease = this.host.transcriptCache.openViewLease(chatId);
		const knownHeads = [{ transcriptViewId: this.host.transcriptViewId, lastOrdinal: this.host.lastOrdinal }];
		const cached = this.host.transcriptCache.readAppliedCursor(chatId);
		if (cached) knownHeads.push(cached);
		const window = { activeChatId: this.host.activeChatId, chatId, transcriptViewId: this.host.transcriptViewId,
			entryCount: this.host.entries.length, loadedThroughOrdinal: this.host.loadedThroughOrdinal,
			nextBeforeOrdinal: this.host.nextBeforeOrdinal };
		try {
			const result = await this.host.transcriptCache.headReads.load(chatId, {
				...options, combinedMode: this.host.combinedMode, knownHeads,
				isDisjoint: page => transcriptSnapshotInstallMode({ ...window, page }) === 'preserve-window',
			});
			if (!this.options.isCurrentLoad(epoch)) return result;
			if (result.kind === 'unavailable' && result.lease.isCurrent()) {
				this.options.onHistoryUnavailable(chatId, result.response.historyState);
				return result;
			}
			if (result.kind === 'complete' && result.lease.isCurrent()) {
				this.options.installPage(chatId, { ...result.page, resendCandidates: undefined }, epoch, result.resetWindow ? 'replace' : undefined,
					result.anchorSnapshot, result.lease);
				if (result.page.resendCandidates) this.publishResendCandidates(chatId, result.page.resendCandidates, result.frontier);
			} else {
				this.host.abortSnapshotLoad(epoch);
				if (lease.isLive()) this.installCachedSnapshot(chatId);
			}
			return result;
		} catch (error) {
			if (!this.options.isCurrentLoad(epoch)) {
				this.host.abortSnapshotLoad(epoch);
				return { kind: 'invalidated' };
			}
			if (this.options.finishFailedLoad(chatId, epoch)) {
				this.host.loadStatus = 'error';
				this.host.loadError = error instanceof Error ? error.message : 'Failed to load messages';
			}
			throw error;
		}
	}
	#publishSnapshotCache(chatId: string, page: TranscriptPage): void {
		const current = this.restoreCache(chatId);
		if (current && !current.stale && current.transcriptViewId === page.transcriptViewId) {
			if (current.lastOrdinal > page.pageNewestOrdinal) return;
			if (current.lastOrdinal === page.pageNewestOrdinal
				&& (current.nextBeforeOrdinal ?? 1) <= (page.nextBeforeOrdinal ?? 1)) return;
		}
		this.host.transcriptCache.replaceFromPage(chatId, page);
	}
}
