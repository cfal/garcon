import { SvelteMap } from 'svelte/reactivity';
import {
	applyTranscriptAppend,
	type TranscriptAppend,
	type TranscriptMessage,
	type TranscriptPage,
} from '$shared/chat-view';
import {
	LocalChatTranscriptStorage,
	type CachedChatCursor,
} from '$lib/chat/transcript/chat-transcript-storage.js';
import {
	mergeTranscriptEntriesByOrdinal,
	retainedEarlierPageCursor,
} from './transcript-page-progress.js';
import { TranscriptHeadCoordinator, type HeadReadCommit } from './transcript-head-coordinator.js';
import type { TranscriptWindowPage } from './transcript-window-loader.js';

export const CHAT_TRANSCRIPT_CACHE_LIMIT = 25;

export type ChatTranscriptApplyResult =
	| { status: 'applied'; changed: boolean; lastOrdinal: number; acceptance?: TranscriptViewAcceptance }
	| { status: 'missing-base' }
	| { status: 'view-changed' }
	| { status: 'gap-detected'; expectedOrdinal: number; receivedOrdinal: number };

export interface ChatTranscriptCursor {
	chatId: string;
	transcriptViewId: string;
	lastOrdinal: number;
}

export interface ChatTranscriptAppliedCursor {
	transcriptViewId: string;
	lastOrdinal: number;
	stale: boolean;
}

export interface ChatTranscriptSnapshot {
	chatId: string;
	transcriptViewId: string;
	messages: TranscriptMessage[];
	lastOrdinal: number;
	oldestOrdinal: number;
	nextBeforeOrdinal: number | null;
	stale: boolean;
}

export interface ChatTranscriptCacheOptions {
	limit: number;
	maxHiddenEntries?: number;
	storage?: LocalChatTranscriptStorage;
	persistenceDelayMs?: number;
	setTimeoutFn?: SetTimeoutFn;
	clearTimeoutFn?: ClearTimeoutFn;
}

interface ChatTranscriptPersistDraft {
	chatId: string;
	transcriptViewId: string;
	lastOrdinal: number;
	nextBeforeOrdinal: number | null;
	messages: TranscriptMessage[];
}

type TimeoutHandle = ReturnType<typeof setTimeout>;
type SetTimeoutFn = (callback: () => void, delayMs: number) => TimeoutHandle;
type ClearTimeoutFn = (timer: TimeoutHandle) => void;

interface TranscriptValidationGuard {
	chatId: string;
	current: boolean;
}

interface TranscriptViewOwner {
	viewId: string | null;
	generation: number;
	missedFrontier: { viewId: string; lastOrdinal: number } | null;
	recoveryFloor: number;
	// Null denotes an announced replacement without a known destination.
	pending: string | null | undefined;
}

export interface TranscriptViewAcceptance {
	viewId: string;
	previousViewId: string | null;
	replaced: boolean;
	resetOverlays: boolean;
}

export interface TranscriptViewLease {
	readonly chatId: string;
	isCurrent(): boolean;
	// Cold reads may still accept a matching first view, but cannot publish viewless outcomes.
	isLive(): boolean;
	continuationIsCurrent(): boolean;
	accept(viewId: string): TranscriptViewAcceptance | null;
}

function nowIso(): string {
	return new Date().toISOString();
}

function snapshotFromEntry(entry: ChatTranscriptSnapshot): ChatTranscriptSnapshot {
	return {
		chatId: entry.chatId,
		transcriptViewId: entry.transcriptViewId,
		messages: entry.messages,
		lastOrdinal: entry.lastOrdinal,
		oldestOrdinal: entry.oldestOrdinal,
		nextBeforeOrdinal: entry.nextBeforeOrdinal,
		stale: entry.stale,
	};
}

class ChatTranscriptPersistenceQueue {
	#pending = new Map<string, ChatTranscriptPersistDraft>();
	#timer: TimeoutHandle | null = null;
	#batchChatIds: string[] = [];
	#batchIndex = 0;
	#delayMs: number;
	#persist: (draft: ChatTranscriptPersistDraft) => void;
	#setTimeout: SetTimeoutFn;
	#clearTimeout: ClearTimeoutFn;

	constructor(options: {
		delayMs: number;
		persist: (draft: ChatTranscriptPersistDraft) => void;
		setTimeoutFn?: SetTimeoutFn;
		clearTimeoutFn?: ClearTimeoutFn;
	}) {
		this.#delayMs = options.delayMs;
		this.#persist = options.persist;
		this.#setTimeout =
			options.setTimeoutFn ?? ((callback, delayMs) => globalThis.setTimeout(callback, delayMs));
		this.#clearTimeout = options.clearTimeoutFn ?? ((timer) => globalThis.clearTimeout(timer));
	}

	schedule(draft: ChatTranscriptPersistDraft): void {
		this.#pending.set(draft.chatId, draft);
		this.#scheduleDrain(this.#delayMs);
	}

	hasPending(chatId: string): boolean {
		return this.#pending.has(chatId);
	}

	peek(chatId: string): ChatTranscriptPersistDraft | undefined {
		return this.#pending.get(chatId);
	}

	removeExcept(chatIds: ReadonlySet<string>): void {
		for (const chatId of this.#pending.keys()) {
			if (!chatIds.has(chatId)) this.#pending.delete(chatId);
		}
	}

	remove(chatId: string): void {
		this.#pending.delete(chatId);
	}

	flush(): void {
		const drafts = [...this.#pending.values()];
		this.#pending.clear();
		this.#batchChatIds = [];
		this.#batchIndex = 0;
		if (this.#timer !== null) {
			this.#clearTimeout(this.#timer);
			this.#timer = null;
		}
		for (const draft of drafts) this.#persist(draft);
	}

	#scheduleDrain(delayMs: number): void {
		if (this.#timer !== null) return;
		this.#timer = this.#setTimeout(() => this.#drainNext(), delayMs);
	}

	#drainNext(): void {
		this.#timer = null;
		if (this.#batchChatIds.length === 0) this.#batchChatIds = [...this.#pending.keys()];
		const chatId = this.#batchChatIds[this.#batchIndex];
		this.#batchIndex += 1;
		const draft = chatId === undefined ? undefined : this.#pending.get(chatId);
		if (draft) this.#pending.delete(draft.chatId);
		try {
			if (draft) this.#persist(draft);
		} finally {
			if (this.#batchIndex < this.#batchChatIds.length) {
				this.#scheduleDrain(0);
			} else {
				this.#batchChatIds = [];
				this.#batchIndex = 0;
				// New traffic waits for the next coalescing window, even during a long drain.
				if (this.#pending.size > 0) this.#scheduleDrain(this.#delayMs);
			}
		}
	}
}

export class ChatTranscriptCache {
	readonly headReads = new TranscriptHeadCoordinator(this);
	#entries = new SvelteMap<string, ChatTranscriptSnapshot>();
	#viewOwners = new Map<string, TranscriptViewOwner>();
	#snapshotReads = new Set<TranscriptValidationGuard>();
	#replayValidations = new Set<TranscriptValidationGuard>();
	#lastAccessedAt = new Map<string, string>();
	#mountedChatIds = new Set<string>();
	#storage: LocalChatTranscriptStorage;
	#limit: number;
	#maxHiddenEntries: number;
	#persistence: ChatTranscriptPersistenceQueue;

	constructor(options: ChatTranscriptCacheOptions) {
		this.#limit = options.limit;
		this.#maxHiddenEntries = options.maxHiddenEntries ?? CHAT_TRANSCRIPT_CACHE_LIMIT;
		this.#storage = options.storage ?? new LocalChatTranscriptStorage();
		this.#persistence = new ChatTranscriptPersistenceQueue({
			delayMs: options.persistenceDelayMs ?? 800,
			setTimeoutFn: options.setTimeoutFn,
			clearTimeoutFn: options.clearTimeoutFn,
			persist: (draft) => {
				this.#storage.persist(
					draft.chatId,
					draft.messages,
					{
						transcriptViewId: draft.transcriptViewId,
						lastOrdinal: draft.lastOrdinal,
						nextBeforeOrdinal: draft.nextBeforeOrdinal,
					},
					{ limit: this.#limit },
				);
			},
		});
	}

	get(chatId: string): ChatTranscriptSnapshot | null {
		const entry = this.#entries.get(chatId);
		return entry ? snapshotFromEntry(entry) : null;
	}

	acceptedView(chatId: string): string | null {
		return this.#viewOwners.get(chatId)?.viewId ?? null;
	}

	hasPendingReplacement(chatId: string): boolean {
		return this.#viewOwners.get(chatId)?.pending !== undefined;
	}

	needsSnapshotRecovery(chatId: string): boolean {
		return this.#viewOwners.get(chatId)?.missedFrontier != null;
	}

	snapshotRecoveryFloor(chatId: string, viewId: string): number {
		const owner = this.#viewOwners.get(chatId);
		return owner?.missedFrontier && owner.viewId === viewId ? owner.recoveryFloor : 0;
	}

	#coverMissedFrontier(chatId: string, viewId: string, lastOrdinal: number): void {
		const owner = this.#viewOwners.get(chatId);
		if (owner?.missedFrontier && owner.viewId === viewId) {
			owner.recoveryFloor = Math.max(owner.recoveryFloor, lastOrdinal);
		}
		if (owner?.missedFrontier?.viewId === viewId && owner.missedFrontier.lastOrdinal <= lastOrdinal) {
			if (lastOrdinal >= owner.recoveryFloor) owner.missedFrontier = null;
		}
	}

	#viewOwner(chatId: string): TranscriptViewOwner {
		let owner = this.#viewOwners.get(chatId);
		if (!owner) {
			owner = { viewId: null, generation: 0, pending: undefined, missedFrontier: null, recoveryFloor: 0 };
			this.#viewOwners.set(chatId, owner);
		}
		return owner;
	}

	openViewLease(chatId: string): TranscriptViewLease {
		const owner = this.#viewOwner(chatId);
		const initialGeneration = owner.generation;
		let generation = initialGeneration;
		let base = owner.viewId;
		const isLive = () => this.#viewOwners.get(chatId) === owner && owner.generation === generation;
		return {
			chatId,
			isLive,
			isCurrent: () => isLive() && base === owner.viewId,
			continuationIsCurrent: () => this.#viewOwners.get(chatId) === owner && owner.generation === initialGeneration,
			accept: viewId => {
				if (!isLive() || (base !== owner.viewId && viewId !== owner.viewId)) return null;
				if (owner.pending && owner.pending !== viewId && owner.viewId === viewId) return null;
				const replaced = owner.viewId !== null && owner.viewId !== viewId;
				const previousViewId = owner.viewId;
				const resetOverlays = replaced && owner.pending !== null && owner.pending !== viewId;
				if (replaced) owner.generation += 1;
				if (replaced && owner.missedFrontier?.viewId === owner.viewId) owner.missedFrontier = null;
				if (replaced) owner.recoveryFloor = 0;
				owner.viewId = viewId;
				owner.pending = undefined;
				generation = owner.generation;
				base = viewId;
				return { viewId, previousViewId, replaced, resetOverlays };
			},
		};
	}

	announceReplacement(chatId: string, viewId: string | null, previousViewId?: string): 'unchanged' | 'reset' | 'retired' | 'recheck' {
		const owner = this.#viewOwner(chatId);
		if (viewId && owner.viewId === viewId && owner.pending === undefined) return 'unchanged';
		if (owner.pending === viewId || (viewId === null && owner.pending !== undefined)) return 'unchanged';
		const predecessor = owner.pending ?? owner.viewId;
		if (previousViewId && predecessor && predecessor !== previousViewId) return 'recheck';
		const alreadyReset = owner.pending === null;
		owner.pending = viewId;
		if (viewId && owner.missedFrontier?.viewId === predecessor && predecessor !== viewId) owner.missedFrontier = null;
		this.retireOperations(chatId);
		return alreadyReset ? 'retired' : 'reset';
	}

	captureReload(chatId: string): { canApply(viewId: string): boolean; isCurrent(): boolean } {
		const owner = this.#viewOwner(chatId);
		const generation = owner.generation;
		const viewId = owner.viewId;
		const pending = owner.pending;
		const isCurrent = () => this.#viewOwners.get(chatId) === owner && owner.generation === generation && owner.viewId === viewId;
		return {
			isCurrent,
			canApply: next => isCurrent() || (this.#viewOwners.get(chatId) === owner
				&& owner.generation === generation + 1 && owner.viewId === viewId && owner.pending !== pending
				&& (owner.pending === next || owner.pending === null)),
		};
	}

	retireOperations(chatId: string): void {
		this.#viewOwner(chatId).generation += 1;
		this.invalidateSnapshotReads(chatId);
		this.#invalidateGuards(this.#replayValidations, chatId);
	}

	trackSnapshotRead(chatId: string): { isCurrent(): boolean; release(): void } {
		return this.#trackValidation(this.#snapshotReads, chatId);
	}

	beginHeadRead(chatId: string, lease: TranscriptViewLease) {
		const owner = this.#viewOwner(chatId);
		const missed = owner.missedFrontier;
		const read = this.trackSnapshotRead(chatId);
		return {
			...read,
			accept: (page: TranscriptWindowPage, commits: readonly HeadReadCommit[] = []):
				| { kind: 'accepted'; page: TranscriptWindowPage; acceptance: TranscriptViewAcceptance }
				| { kind: 'retired' }
				| { kind: 'retry' } => {
				if (!read.isCurrent() || !lease.isLive()) return { kind: 'retired' };
				for (const commit of commits) {
					if (commit.transcriptViewId !== page.transcriptViewId) continue;
					const appended = applyTranscriptAppend(page.messages, commit.append, page.pageNewestOrdinal);
					if (appended.status === 'gap-detected') continue;
					page = { ...page, messages: appended.messages, pageNewestOrdinal: appended.lastOrdinal,
						lastOrdinal: Math.max(page.lastOrdinal, appended.lastOrdinal) };
				}
				const cached = this.#entries.get(chatId);
				// Keeps contiguous commits received during the read, even when no panel buffered them.
				if (cached?.transcriptViewId === page.transcriptViewId && (!cached.stale || owner.missedFrontier)
					&& cached.lastOrdinal > page.pageNewestOrdinal
					&& (cached.nextBeforeOrdinal ?? 1) <= page.pageNewestOrdinal + 1) {
					page = { ...page, messages: mergeTranscriptEntriesByOrdinal(page.messages, cached.messages),
						lastOrdinal: Math.max(page.lastOrdinal, cached.lastOrdinal), pageNewestOrdinal: cached.lastOrdinal };
				}
				const coverageFloor = Math.max(this.snapshotRecoveryFloor(chatId, page.transcriptViewId),
					cached?.transcriptViewId === page.transcriptViewId && !cached.stale ? cached.lastOrdinal : 0);
				if (page.pageNewestOrdinal < coverageFloor) return { kind: 'retry' };
				const acceptance = lease.accept(page.transcriptViewId);
				if (!acceptance) return { kind: lease.isCurrent() ? 'retry' : 'retired' };
				// Only a head read started after foreign-view debt can disprove it.
				if (owner.missedFrontier === missed && missed?.viewId !== page.transcriptViewId) owner.missedFrontier = null;
				this.#publishPage(chatId, page);
				return { kind: 'accepted', page, acceptance };
			},
		};
	}

	trackReplayValidation(chatId: string): { isCurrent(): boolean; release(): void } {
		return this.#trackValidation(this.#replayValidations, chatId);
	}

	#trackValidation(guards: Set<TranscriptValidationGuard>, chatId: string) {
		const guard = { chatId, current: true };
		guards.add(guard);
		return {
			isCurrent: () => guard.current,
			release: () => { guards.delete(guard); },
		};
	}

	#invalidateGuards(guards: Set<TranscriptValidationGuard>, chatId: string): void {
		for (const guard of guards) {
			if (guard.chatId === chatId) guard.current = false;
		}
	}

	invalidateSnapshotReads(chatId: string): void {
		this.#invalidateGuards(this.#snapshotReads, chatId);
	}

	markAccessed(chatId: string): void {
		if (this.#entries.has(chatId)) this.#lastAccessedAt.set(chatId, nowIso());
	}

	setMountedChatIds(chatIds: readonly string[]): void {
		this.#mountedChatIds = new Set(chatIds);
		this.#prune();
	}

	readAppliedCursor(chatId: string): ChatTranscriptAppliedCursor | null {
		const entry = this.#entries.get(chatId);
		return entry
			? {
					transcriptViewId: entry.transcriptViewId,
					lastOrdinal: entry.lastOrdinal,
					stale: entry.stale,
				}
			: null;
	}

	hydrate(chatId: string): ChatTranscriptSnapshot | null {
		if (!chatId) return null;
		const memory = this.get(chatId);
		if (memory) return memory;
		const draft = this.#persistence.peek(chatId);
		const restored = draft ? { ...draft, entries: draft.messages, stale: false }
			: this.#storage.restore(chatId, { limit: this.#limit });
		if (!restored) return null;
		const owner = this.#viewOwner(chatId);
		if (owner.pending !== undefined || (owner.viewId !== null && owner.viewId !== restored.transcriptViewId)) return null;
		// Cross-tab storage cannot establish a view over an outstanding cold server read.
		if (owner.viewId === null && [...this.#snapshotReads].some(read => read.chatId === chatId)) return null;
		owner.viewId = restored.transcriptViewId;
		if (owner.missedFrontier) owner.recoveryFloor = Math.max(owner.recoveryFloor, restored.lastOrdinal);
		const entry: ChatTranscriptSnapshot = {
			chatId,
			transcriptViewId: restored.transcriptViewId,
			messages: restored.entries,
			lastOrdinal: restored.lastOrdinal,
			oldestOrdinal: restored.entries[0]?.ordinal ?? 0,
			nextBeforeOrdinal: restored.nextBeforeOrdinal,
			stale: restored.stale || this.needsSnapshotRecovery(chatId),
		};
		this.#entries.set(chatId, entry);
		this.#lastAccessedAt.set(chatId, nowIso());
		this.#prune();
		return snapshotFromEntry(entry);
	}

	replaceFromPage(
		chatId: string,
		page: TranscriptPage,
		options: { stale?: boolean } = {},
	): ChatTranscriptSnapshot {
		if (!this.openViewLease(chatId).accept(page.transcriptViewId)) {
			throw new Error('Cannot publish a snapshot for an announced retired view');
		}
		return this.#publishPage(chatId, page, options.stale);
	}

	#publishPage(chatId: string, page: TranscriptPage, stale = false): ChatTranscriptSnapshot {
		this.#coverMissedFrontier(chatId, page.transcriptViewId, page.pageNewestOrdinal);
		const windowed = page.messages.slice(-this.#limit);
		const nextBeforeOrdinal = retainedEarlierPageCursor(
			page.messages,
			windowed,
			page.nextBeforeOrdinal,
		);
		const now = nowIso();
		const entry: ChatTranscriptSnapshot = {
			chatId,
			transcriptViewId: page.transcriptViewId,
			messages: windowed,
			lastOrdinal: page.pageNewestOrdinal,
			oldestOrdinal: windowed[0]?.ordinal ?? 0,
			nextBeforeOrdinal,
			stale: stale || this.needsSnapshotRecovery(chatId),
		};
		this.#entries.set(chatId, entry);
		this.#lastAccessedAt.set(chatId, now);
		if (!entry.stale) this.#persistence.schedule(entry);
		this.#prune();
		return snapshotFromEntry(entry);
	}

	replace(
		chatId: string,
		transcriptViewId: string,
		messages: TranscriptMessage[],
		lastOrdinal: number,
		nextBeforeOrdinal: number | null,
	): ChatTranscriptSnapshot {
		return this.replaceFromPage(chatId, {
			transcriptViewId,
			messages,
			lastOrdinal,
			pageOldestOrdinal: messages[0]?.ordinal ?? 0,
			pageNewestOrdinal: lastOrdinal,
			nextBeforeOrdinal,
			hasMore: nextBeforeOrdinal !== null,
		});
	}

	applyEarlierPage(
		chatId: string,
		transcriptViewId: string,
		requestBeforeOrdinal: number,
		page: TranscriptPage,
	): void {
		let entry = this.#entries.get(chatId);
		if (!entry) {
			this.hydrate(chatId);
			entry = this.#entries.get(chatId);
		}
		if (
			!entry
			|| entry.stale
			|| entry.transcriptViewId !== transcriptViewId
			|| entry.nextBeforeOrdinal !== requestBeforeOrdinal
		) return;

		const merged = mergeTranscriptEntriesByOrdinal(page.messages, entry.messages);
		const windowed = merged.slice(-this.#limit);
		const next: ChatTranscriptSnapshot = {
			...entry,
			messages: windowed,
			lastOrdinal: entry.lastOrdinal,
			oldestOrdinal: windowed[0]?.ordinal ?? 0,
			nextBeforeOrdinal: retainedEarlierPageCursor(
				merged,
				windowed,
				page.nextBeforeOrdinal,
			),
		};
		this.#entries.set(chatId, next);
		this.#lastAccessedAt.set(chatId, nowIso());
		this.#persistence.schedule(next);
	}

	applyMessages(
		chatId: string,
		transcriptViewId: string,
		append: Pick<TranscriptAppend, 'firstOrdinal' | 'lastOrdinal' | 'messages'>,
	): ChatTranscriptApplyResult {
		this.headReads.recordCommit(chatId, transcriptViewId, append);
		const outcome = this.#applyMessages(chatId, transcriptViewId, append);
		if (outcome.status === 'applied') {
			this.#coverMissedFrontier(chatId, transcriptViewId, outcome.lastOrdinal);
		} else if (chatId && transcriptViewId) {
			const owner = this.#viewOwner(chatId);
			if (!owner.pending || owner.pending === transcriptViewId) {
				const previous = owner.missedFrontier;
				owner.recoveryFloor = Math.max(previous ? owner.recoveryFloor : 0, this.#entries.get(chatId)?.lastOrdinal ?? 0);
				owner.missedFrontier = { viewId: transcriptViewId, lastOrdinal: Math.max(append.lastOrdinal,
					previous?.viewId === transcriptViewId ? previous.lastOrdinal : 0) };
				this.markStale(chatId);
			}
		}
		return outcome;
	}

	#applyMessages(
		chatId: string,
		transcriptViewId: string,
		append: Pick<TranscriptAppend, 'firstOrdinal' | 'lastOrdinal' | 'messages'>,
	): ChatTranscriptApplyResult {
		if (!chatId || !transcriptViewId) return { status: 'missing-base' };
		const owner = this.#viewOwner(chatId);
		if (owner.pending && owner.pending !== transcriptViewId) return { status: 'view-changed' };
		if (owner.viewId && owner.viewId !== transcriptViewId && owner.pending !== transcriptViewId && owner.pending !== null) {
			return { status: 'view-changed' };
		}
		let entry = this.#entries.get(chatId);
		if (!entry) {
			this.hydrate(chatId);
			entry = this.#entries.get(chatId);
		}
		if (!entry) return this.#createFromInitialBatch(chatId, transcriptViewId, append);
		if (entry.transcriptViewId !== transcriptViewId) {
			return { status: 'view-changed' };
		}

		const applied = applyTranscriptAppend(entry.messages, append, entry.lastOrdinal);
		if (applied.status === 'gap-detected') {
			return {
				status: 'gap-detected',
				expectedOrdinal: applied.expectedOrdinal ?? entry.lastOrdinal + 1,
				receivedOrdinal: applied.receivedOrdinal ?? append.firstOrdinal,
			};
		}
		if (!applied.changed && applied.lastOrdinal === entry.lastOrdinal && !entry.stale) {
			this.#lastAccessedAt.set(chatId, nowIso());
			// Redundant delivery also repairs failed writes and cross-tab snapshot eviction.
			if (!this.#persistence.hasPending(chatId)) this.#persistence.schedule(entry);
			return { status: 'applied', changed: false, lastOrdinal: entry.lastOrdinal };
		}
		const windowed = applied.messages.slice(-this.#limit);
		const next: ChatTranscriptSnapshot = {
			...entry,
			messages: windowed,
			lastOrdinal: applied.lastOrdinal,
			oldestOrdinal: windowed[0]?.ordinal ?? 0,
			nextBeforeOrdinal: retainedEarlierPageCursor(
				applied.messages,
				windowed,
				entry.nextBeforeOrdinal,
			),
		};
		this.#entries.set(chatId, next);
		this.#lastAccessedAt.set(chatId, nowIso());
		if (!next.stale) this.#persistence.schedule(next);
		return { status: 'applied', changed: applied.changed, lastOrdinal: next.lastOrdinal };
	}

	markStale(chatId: string): void {
		if (!chatId) return;
		// Per-chat staleness must not cancel the snapshot read that repairs it.
		this.#invalidateGuards(this.#replayValidations, chatId);
		this.#persistence.remove(chatId);
		const current = this.#entries.get(chatId);
		if (current) this.#entries.set(chatId, { ...current, stale: true });
		this.#storage.markStale(chatId);
	}

	markStaleExcept(chatIds: ReadonlySet<string>): void {
		// Includes drafts and reads whose entries have already left the memory cache.
		this.#persistence.removeExcept(chatIds);
		for (const guard of [...this.#snapshotReads, ...this.#replayValidations]) {
			if (!chatIds.has(guard.chatId)) guard.current = false;
		}
		for (const [chatId, entry] of this.#entries) {
			if (!chatIds.has(chatId)) this.#entries.set(chatId, { ...entry, stale: true });
		}
		this.#storage.markStaleExcept(chatIds);
	}

	markValidated(chatId: string): void {
		if (!chatId) return;
		const current = this.#entries.get(chatId);
		if (!current) return;
		this.#coverMissedFrontier(chatId, current.transcriptViewId, current.lastOrdinal);
		if (this.needsSnapshotRecovery(chatId)) return;
		const validated = { ...current, stale: false };
		this.#entries.set(chatId, validated);
		// Persists the validated frontier, not an older snapshot whose draft was cancelled.
		this.#persistence.schedule(validated);
	}

	listCursors(limit = 20): ChatTranscriptCursor[] {
		const boundedLimit = Math.max(0, Math.floor(limit));
		if (boundedLimit === 0) return [];

		const memory = [...this.#entries.values()]
			.filter((entry) => entry.transcriptViewId && entry.lastOrdinal > 0 && !entry.stale)
			.sort((left, right) =>
				(this.#lastAccessedAt.get(right.chatId) ?? '').localeCompare(
					this.#lastAccessedAt.get(left.chatId) ?? '',
				),
			)
			.map(
				(entry): ChatTranscriptCursor => ({
					chatId: entry.chatId,
					transcriptViewId: entry.transcriptViewId,
					lastOrdinal: entry.lastOrdinal,
				}),
			);
		if (memory.length >= boundedLimit) return memory.slice(0, boundedLimit);

		const seen = new Set(this.#entries.keys());
		const persisted = this.#storage
			.listCursors(boundedLimit)
			.filter((cursor: CachedChatCursor) => !seen.has(cursor.chatId)
				&& !this.needsSnapshotRecovery(cursor.chatId)
				&& this.#viewOwners.get(cursor.chatId)?.pending === undefined
				&& (!this.acceptedView(cursor.chatId) || this.acceptedView(cursor.chatId) === cursor.transcriptViewId));
		return [...memory, ...persisted].slice(0, boundedLimit);
	}

	remove(chatId: string): void {
		this.discardData(chatId);
		this.#viewOwners.delete(chatId);
	}

	retainChats(chatIds: ReadonlySet<string>): void {
		for (const chatId of this.#viewOwners.keys()) {
			if (!chatIds.has(chatId) && !this.#mountedChatIds.has(chatId)) this.remove(chatId);
		}
	}

	retireAllOperations(): void {
		for (const chatId of this.#viewOwners.keys()) this.retireOperations(chatId);
	}

	discardData(chatId: string): void {
		if (!chatId) return;
		this.invalidateSnapshotReads(chatId);
		this.#invalidateGuards(this.#replayValidations, chatId);
		this.#entries.delete(chatId);
		this.#lastAccessedAt.delete(chatId);
		this.#storage.remove(chatId);
		this.#persistence.remove(chatId);
	}

	discardInvalidFrontier(chatId: string, viewId: string): void {
		const owner = this.#viewOwners.get(chatId);
		if (owner?.viewId !== viewId) return;
		owner.recoveryFloor = 0;
		this.discardData(chatId);
	}

	flush(): void {
		this.#persistence.flush();
	}

	#createFromInitialBatch(
		chatId: string,
		transcriptViewId: string,
		append: Pick<TranscriptAppend, 'firstOrdinal' | 'lastOrdinal' | 'messages'>,
	): ChatTranscriptApplyResult {
		if (append.firstOrdinal !== 1) {
			return { status: 'missing-base' };
		}
		const applied = applyTranscriptAppend([], append, 0);
		if (applied.status === 'gap-detected') {
			return {
				status: 'gap-detected',
				expectedOrdinal: applied.expectedOrdinal ?? 1,
				receivedOrdinal: applied.receivedOrdinal ?? append.firstOrdinal,
			};
		}
		const acceptance = this.openViewLease(chatId).accept(transcriptViewId);
		if (!acceptance) return { status: 'view-changed' };
		this.#coverMissedFrontier(chatId, transcriptViewId, applied.lastOrdinal);
		const windowed = applied.messages.slice(-this.#limit);
		const now = nowIso();
		const entry: ChatTranscriptSnapshot = {
			chatId,
			transcriptViewId,
			messages: windowed,
			lastOrdinal: applied.lastOrdinal,
			oldestOrdinal: windowed[0]?.ordinal ?? 0,
			nextBeforeOrdinal: retainedEarlierPageCursor(applied.messages, windowed, null),
			stale: this.needsSnapshotRecovery(chatId),
		};
		this.#entries.set(chatId, entry);
		this.#lastAccessedAt.set(chatId, now);
		if (!entry.stale) this.#persistence.schedule(entry);
		this.#prune();
		return { status: 'applied', changed: true, lastOrdinal: entry.lastOrdinal, acceptance };
	}

	#prune(): void {
		const hidden = [...this.#entries.values()].filter(
			(entry) => !this.#mountedChatIds.has(entry.chatId),
		);
		if (hidden.length <= this.#maxHiddenEntries) return;
		hidden.sort((left, right) =>
			(this.#lastAccessedAt.get(left.chatId) ?? '').localeCompare(
				this.#lastAccessedAt.get(right.chatId) ?? '',
			),
		);
		for (const entry of hidden.slice(0, hidden.length - this.#maxHiddenEntries)) {
			this.#entries.delete(entry.chatId);
			this.#lastAccessedAt.delete(entry.chatId);
		}
	}
}
