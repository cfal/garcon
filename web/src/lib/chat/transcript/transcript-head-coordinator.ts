import type { ChatLoadMessagesOptions, ChatCursor } from './active-transcript-port.js';
import type { ChatTranscriptCache, TranscriptViewAcceptance, TranscriptViewLease } from './chat-transcript-cache.svelte.js';
import { TRANSCRIPT_ANCHOR_TARGET } from '$shared/transcript-anchor-page';
import { loadTranscriptAnchorSnapshot, type TranscriptAnchorSnapshot } from './transcript-anchor-demand.js';
import { collapseBackwardTranscriptDemand, loadTranscriptPageDemand } from './transcript-page-demand.js';
import type { UnavailableChatHistoryResponse, TranscriptAppend } from '$shared/chat-view';
import type { TranscriptWindowPage } from './transcript-window-loader.js';

export interface TranscriptHeadRequest extends ChatLoadMessagesOptions {
	combinedMode: boolean;
	knownHeads: readonly ChatCursor[];
	isDisjoint?: (page: TranscriptWindowPage) => boolean;
}

export type TranscriptHeadReadResult =
	| { kind: 'complete'; page: TranscriptWindowPage; anchorSnapshot?: TranscriptAnchorSnapshot }
	| { kind: 'unavailable'; response: UnavailableChatHistoryResponse }
	| { kind: 'cursor-ahead'; transcriptViewId?: string }
	| { kind: 'view-changed' }
	| { kind: 'invalidated' };

export async function readTranscriptHead(
	chatId: string,
	request: TranscriptHeadRequest,
	isCurrent: () => boolean,
): Promise<TranscriptHeadReadResult> {
	if (request.combinedMode) {
		const result = await loadTranscriptAnchorSnapshot({
			request: { chatId, direction: 'backward', anchorsRemaining: TRANSCRIPT_ANCHOR_TARGET,
				...(request.purpose ? { purpose: request.purpose } : {}) },
			knownHeads: request.knownHeads,
			isDisjoint: request.isDisjoint,
			isCurrent,
		});
		return result.kind === 'complete' ? { kind: 'complete', page: result.page, anchorSnapshot: result } : result;
	}
	const result = await loadTranscriptPageDemand({ direction: 'backward', chatId,
		visibleLimit: Math.max(50, Math.floor(request.minimumLimit ?? 50)), purpose: request.purpose, isCurrent });
	return result.kind === 'complete' ? { kind: 'complete', page: collapseBackwardTranscriptDemand(result) } : result;
}

export type TranscriptHeadResult =
	| { kind: 'complete'; page: TranscriptWindowPage; frontier: ChatCursor; anchorSnapshot?: TranscriptAnchorSnapshot; lease: TranscriptViewLease; resetWindow: boolean }
	| { kind: 'unavailable'; response: UnavailableChatHistoryResponse; lease: TranscriptViewLease }
	| { kind: 'incomplete' | 'invalidated' };

interface HeadOperation {
	lease: TranscriptViewLease;
	request: TranscriptHeadRequest;
	canCoverDemand(): boolean;
	promise: Promise<TranscriptHeadResult>;
	commits: HeadReadCommit[];
}

export interface HeadReadCommit {
	transcriptViewId: string;
	append: Pick<TranscriptAppend, 'firstOrdinal' | 'lastOrdinal' | 'messages'>;
}

type HeadPublication = { kind: 'accepted'; acceptance: TranscriptViewAcceptance }
	| { kind: 'cursor-reset'; viewId: string };

/** Owns one bounded head read per chat, independent of panel lifetime. */
export class TranscriptHeadCoordinator {
	#pending = new Map<string, HeadOperation>();
	#listeners = new Set<(chatId: string, publication: HeadPublication) => void>();
	read = readTranscriptHead;

	constructor(private readonly cache: ChatTranscriptCache) {}

	onPublication(listener: (chatId: string, publication: HeadPublication) => void): () => void {
		this.#listeners.add(listener);
		return () => { this.#listeners.delete(listener); };
	}

	recordCommit(chatId: string, transcriptViewId: string, append: HeadReadCommit['append']): void {
		const operation = this.#pending.get(chatId);
		if (operation?.lease.isLive()) operation.commits.push({ transcriptViewId, append });
	}

	pending(chatId: string): Promise<TranscriptHeadResult> | undefined {
		const operation = this.#pending.get(chatId);
		return operation?.lease.isLive() ? operation.promise : undefined;
	}

	load(chatId: string, request: TranscriptHeadRequest): Promise<TranscriptHeadResult> {
		const pending = this.#pending.get(chatId);
		if (pending?.lease.isLive()) {
			const covered = pending.canCoverDemand() && request.combinedMode === pending.request.combinedMode
				&& (request.combinedMode || Math.max(50, pending.request.minimumLimit ?? 50) >= Math.max(50, request.minimumLimit ?? 50))
				&& (request.purpose === undefined || pending.request.purpose === request.purpose);
			if (covered) return pending.promise;
			const continuationIsCurrent = pending.lease.continuationIsCurrent;
			return pending.promise.then(result => continuationIsCurrent()
				? this.load(chatId, request) : result);
		}
		const lease = this.cache.openViewLease(chatId);
		const operation: HeadOperation = { lease, request, canCoverDemand: () => true,
			commits: [], promise: Promise.resolve({ kind: 'invalidated' }) };
		this.#pending.set(chatId, operation);
		operation.promise = this.#perform(chatId, operation).finally(() => {
			if (this.#pending.get(chatId) === operation) this.#pending.delete(chatId);
		});
		return operation.promise;
	}

	async #perform(chatId: string, operation: HeadOperation): Promise<TranscriptHeadResult> {
		let request = operation.request;
		let resetWindow = false;
		for (let attempt = 0; attempt < 2; attempt += 1) {
			if (operation.lease.isLive() && !operation.lease.isCurrent()) operation.lease = this.cache.openViewLease(chatId);
			const lease = operation.lease;
			if (!lease.isLive()) return { kind: 'invalidated' };
			const read = this.cache.beginHeadRead(chatId, lease);
			operation.canCoverDemand = () => attempt === 0 || read.isCurrent();
			try {
				const result = await this.read(chatId, request, () => lease.isLive() && read.isCurrent());
				if (!lease.isLive()) return { kind: 'invalidated' };
				if (!read.isCurrent() || result.kind === 'invalidated' || result.kind === 'view-changed') continue;
				if (result.kind === 'cursor-ahead') {
					const viewId = result.transcriptViewId ?? this.cache.acceptedView(chatId);
					if (viewId) {
						this.cache.retireOperations(chatId);
						this.cache.discardInvalidFrontier(chatId, viewId);
						operation.lease = this.cache.openViewLease(chatId);
						operation.commits = [];
						for (const listener of this.#listeners) listener(chatId, { kind: 'cursor-reset', viewId });
					}
					resetWindow = true;
					request = { ...request, knownHeads: [], purpose: undefined };
					continue;
				}
				if (result.kind === 'unavailable') {
					if (!lease.isCurrent() && this.cache.needsSnapshotRecovery(chatId)) continue;
					return lease.isCurrent() ? { ...result, lease } : { kind: 'invalidated' };
				}
				const accepted = read.accept(result.page, operation.commits);
				if (accepted.kind === 'retired') return { kind: 'invalidated' };
				if (accepted.kind === 'retry') continue;
				for (const listener of this.#listeners) listener(chatId, { kind: 'accepted', acceptance: accepted.acceptance });
				if (!this.cache.needsSnapshotRecovery(chatId)) {
					return { ...result, page: accepted.page, frontier: result.page, lease, resetWindow };
				}
				request = { ...request, purpose: undefined };
			} catch (error) {
				if (!lease.isLive()) return { kind: 'invalidated' };
				if (!read.isCurrent()) continue;
				if (!lease.isCurrent()) {
					if (this.cache.needsSnapshotRecovery(chatId)) continue;
					return { kind: 'invalidated' };
				}
				throw error;
			} finally {
				read.release();
			}
		}
		this.cache.markStale(chatId);
		return { kind: 'incomplete' };
	}
}
