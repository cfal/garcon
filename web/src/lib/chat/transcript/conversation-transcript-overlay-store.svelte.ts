import { SvelteMap } from 'svelte/reactivity';
import type { ResendCandidate, TranscriptMessage } from '$shared/chat-view';
import type { LocalNoticeRow, LocalNoticeType } from './local-notice.js';
import type { OptimisticUserInput } from './optimistic-user-input.js';
import { echoedClientMessageOrdinals } from './transcript-row-projection.js';
import { createRandomId } from '$lib/utils/random-id';

const SERVER_NOTICE_RETENTION_LIMIT = 8;

type OverlayNotice = LocalNoticeRow & {
	readonly revision: number;
	readonly source: 'local' | 'server';
};

export interface ConversationTranscriptOverlayMutation {
	readonly feedStructureChanged: boolean;
}

export interface ConversationTranscriptOverlayView {
	readonly notices: readonly (LocalNoticeRow & { readonly revision: number })[];
	readonly noticeRevision: number;
	readonly optimisticInputs: readonly OptimisticUserInput[];
	readonly optimisticAfterOrdinals: ReadonlyMap<string, number>;
	readonly resendCandidates: readonly ResendCandidate[];
	readonly includedResendCandidates: readonly ResendCandidate[];
	readonly excludedResendOrdinals: readonly number[];
}

export interface CommittedOverlayBatch {
	readonly chatId: string;
	readonly messages: readonly TranscriptMessage[];
	readonly resendCandidates: readonly ResendCandidate[];
	readonly noticeRevision: number;
}

function feedMutation(feedStructureChanged: boolean): ConversationTranscriptOverlayMutation {
	return { feedStructureChanged };
}

class ConversationTranscriptOverlayEntry implements ConversationTranscriptOverlayView {
	#notices = $state<OverlayNotice[]>([]);
	#noticeRevision = $state(0);
	#optimisticInputs = $state<OptimisticUserInput[]>([]);
	#optimisticAfterOrdinals = $state.raw<ReadonlyMap<string, number>>(new Map());
	#resendCandidates = $state<ResendCandidate[]>([]);
	#excludedResendOrdinals = $state<number[]>([]);

	get notices(): readonly (LocalNoticeRow & { readonly revision: number })[] {
		return this.#notices;
	}

	get noticeRevision(): number {
		return this.#noticeRevision;
	}

	get optimisticInputs(): readonly OptimisticUserInput[] {
		return this.#optimisticInputs;
	}

	get optimisticAfterOrdinals(): ReadonlyMap<string, number> {
		return this.#optimisticAfterOrdinals;
	}

	get resendCandidates(): readonly ResendCandidate[] {
		return this.#resendCandidates;
	}

	get includedResendCandidates(): readonly ResendCandidate[] {
		const excluded = new Set(this.#excludedResendOrdinals);
		return this.#resendCandidates.filter((candidate) => !excluded.has(candidate.ordinal));
	}

	get excludedResendOrdinals(): readonly number[] {
		return this.#excludedResendOrdinals;
	}

	appendNotice(
		source: OverlayNotice['source'],
		noticeType: LocalNoticeType,
		content: string,
	): ConversationTranscriptOverlayMutation {
		const notice: OverlayNotice = {
			kind: 'local-notice',
			id: `${source}_${createRandomId()}`,
			noticeType,
			content,
			timestamp: new Date().toISOString(),
			revision: ++this.#noticeRevision,
			source,
		};
		let notices = [...this.#notices, notice];
		if (source === 'server') {
			const serverNotices = notices.filter((entry) => entry.source === 'server');
			const excess = serverNotices.length - SERVER_NOTICE_RETENTION_LIMIT;
			if (excess > 0) {
				const removed = new Set(serverNotices.slice(0, excess).map((entry) => entry.id));
				notices = notices.filter((entry) => !removed.has(entry.id));
			}
		}
		this.#notices = notices;
		return feedMutation(true);
	}

	clearNoticesThrough(revision = this.#noticeRevision): ConversationTranscriptOverlayMutation {
		const next = this.#notices.filter((notice) => notice.revision > revision);
		if (next.length === this.#notices.length) return feedMutation(false);
		this.#notices = next;
		return feedMutation(true);
	}

	upsertOptimisticInput(
		input: OptimisticUserInput,
		afterOrdinal: number,
	): ConversationTranscriptOverlayMutation {
		if (!this.#optimisticAfterOrdinals.has(input.clientMessageId)) {
			this.#optimisticAfterOrdinals = new Map(this.#optimisticAfterOrdinals).set(
				input.clientMessageId,
				afterOrdinal,
			);
		}
		const index = this.#optimisticInputs.findIndex(
			(entry) => entry.clientMessageId === input.clientMessageId,
		);
		this.#optimisticInputs =
			index === -1 ? [...this.#optimisticInputs, input] : this.#optimisticInputs.with(index, input);
		return feedMutation(true);
	}

	markOptimisticInputDelivered(clientMessageId: string): ConversationTranscriptOverlayMutation {
		const index = this.#optimisticInputs.findIndex(
			(input) => input.clientMessageId === clientMessageId,
		);
		const input = this.#optimisticInputs[index];
		if (!input || input.delivery === 'delivered') return feedMutation(false);
		this.#optimisticInputs = this.#optimisticInputs.with(index, {
			...input,
			delivery: 'delivered',
		});
		return feedMutation(true);
	}

	clearOptimisticInput(clientMessageId: string): ConversationTranscriptOverlayMutation {
		const next = this.#optimisticInputs.filter(
			(input) => input.clientMessageId !== clientMessageId,
		);
		if (next.length === this.#optimisticInputs.length) return feedMutation(false);
		const ordinals = new Map(this.#optimisticAfterOrdinals);
		ordinals.delete(clientMessageId);
		this.#optimisticAfterOrdinals = ordinals;
		this.#optimisticInputs = next;
		return feedMutation(true);
	}

	replaceResendCandidates(
		candidates: readonly ResendCandidate[],
	): ConversationTranscriptOverlayMutation {
		this.#installResendCandidates(candidates);
		return feedMutation(false);
	}

	excludeResendCandidate(ordinal: number): ConversationTranscriptOverlayMutation {
		if (!this.#resendCandidates.some((candidate) => candidate.ordinal === ordinal)) {
			return feedMutation(false);
		}
		if (this.#excludedResendOrdinals.includes(ordinal)) return feedMutation(false);
		this.#excludedResendOrdinals = [...this.#excludedResendOrdinals, ordinal].sort(
			(left, right) => left - right,
		);
		return feedMutation(false);
	}

	clearResendExclusions(): ConversationTranscriptOverlayMutation {
		if (this.#excludedResendOrdinals.length === 0) return feedMutation(false);
		this.#excludedResendOrdinals = [];
		return feedMutation(false);
	}

	applyCommittedBatch(batch: CommittedOverlayBatch): ConversationTranscriptOverlayMutation {
		let feedStructureChanged = false;
		const notices = this.#notices.filter((notice) => notice.revision > batch.noticeRevision);
		if (notices.length !== this.#notices.length) {
			this.#notices = notices;
			feedStructureChanged = true;
		}

		const echoed = echoedClientMessageOrdinals(batch.messages);
		if (echoed.size > 0) {
			const ordinals = new Map(this.#optimisticAfterOrdinals);
			const remaining: OptimisticUserInput[] = [];
			let latestPriorEchoOrdinal: number | undefined;
			for (const input of this.#optimisticInputs) {
				const echoOrdinal = echoed.get(input.clientMessageId);
				if (echoOrdinal !== undefined) {
					latestPriorEchoOrdinal = Math.max(latestPriorEchoOrdinal ?? 0, echoOrdinal);
					ordinals.delete(input.clientMessageId);
					continue;
				}
				if (latestPriorEchoOrdinal !== undefined) {
					ordinals.set(
						input.clientMessageId,
						Math.max(ordinals.get(input.clientMessageId) ?? 0, latestPriorEchoOrdinal),
					);
				}
				remaining.push(input);
			}
			if (remaining.length !== this.#optimisticInputs.length) {
				this.#optimisticInputs = remaining;
				this.#optimisticAfterOrdinals = ordinals;
				feedStructureChanged = true;
			}
		}

		this.#installResendCandidates(batch.resendCandidates);
		return feedMutation(feedStructureChanged);
	}

	#installResendCandidates(candidates: readonly ResendCandidate[]): void {
		this.#resendCandidates = candidates.map((candidate) => ({
			...candidate,
			attachmentNames: [...candidate.attachmentNames],
		}));
		const available = new Set(candidates.map((candidate) => candidate.ordinal));
		this.#excludedResendOrdinals = this.#excludedResendOrdinals.filter((ordinal) =>
			available.has(ordinal),
		);
	}

	resetForTranscriptReplacement(): ConversationTranscriptOverlayMutation {
		const feedStructureChanged = this.#notices.length > 0 || this.#optimisticInputs.length > 0;
		this.#notices = [];
		this.#noticeRevision = 0;
		this.#optimisticInputs = [];
		this.#optimisticAfterOrdinals = new Map();
		this.#resendCandidates = [];
		this.#excludedResendOrdinals = [];
		return feedMutation(feedStructureChanged);
	}
}

export class ConversationTranscriptOverlayStore {
	#entries = new SvelteMap<string, ConversationTranscriptOverlayEntry>();

	forChat(chatId: string): ConversationTranscriptOverlayView {
		return this.#entry(chatId);
	}

	viewFor(chatId: string): ConversationTranscriptOverlayView | null {
		return this.#entries.get(chatId) ?? null;
	}

	noticeRevisionFor(chatId: string): number {
		return this.#entries.get(chatId)?.noticeRevision ?? 0;
	}

	appendLocalNotice(
		chatId: string,
		noticeType: LocalNoticeType,
		content: string,
	): ConversationTranscriptOverlayMutation {
		return this.#entry(chatId).appendNotice('local', noticeType, content);
	}

	appendServerNotice(
		chatId: string,
		noticeType: LocalNoticeType,
		content: string,
	): ConversationTranscriptOverlayMutation {
		return this.#entry(chatId).appendNotice('server', noticeType, content);
	}

	clearNoticesThrough(chatId: string, revision?: number): ConversationTranscriptOverlayMutation {
		return this.#entry(chatId).clearNoticesThrough(revision);
	}

	upsertOptimisticInput(
		chatId: string,
		input: OptimisticUserInput,
		afterOrdinal: number,
	): ConversationTranscriptOverlayMutation {
		return this.#entry(chatId).upsertOptimisticInput(input, afterOrdinal);
	}

	markOptimisticInputDelivered(
		chatId: string,
		clientMessageId: string,
	): ConversationTranscriptOverlayMutation | null {
		return this.#entries.get(chatId)?.markOptimisticInputDelivered(clientMessageId) ?? null;
	}

	clearOptimisticInput(
		chatId: string,
		clientMessageId: string,
	): ConversationTranscriptOverlayMutation | null {
		return this.#entries.get(chatId)?.clearOptimisticInput(clientMessageId) ?? null;
	}

	replaceResendCandidates(
		chatId: string,
		candidates: readonly ResendCandidate[],
	): ConversationTranscriptOverlayMutation {
		return this.#entry(chatId).replaceResendCandidates(candidates);
	}

	excludeResendCandidate(chatId: string, ordinal: number): ConversationTranscriptOverlayMutation {
		return this.#entry(chatId).excludeResendCandidate(ordinal);
	}

	clearResendExclusions(chatId: string): ConversationTranscriptOverlayMutation {
		return this.#entry(chatId).clearResendExclusions();
	}

	applyCommittedBatch(batch: CommittedOverlayBatch): ConversationTranscriptOverlayMutation {
		return this.#entry(batch.chatId).applyCommittedBatch(batch);
	}

	resetForTranscriptReplacement(chatId: string): ConversationTranscriptOverlayMutation {
		return this.#entry(chatId).resetForTranscriptReplacement();
	}

	remove(chatId: string): void {
		this.#entries.delete(chatId);
	}

	prune(activeChatIds: ReadonlySet<string>): void {
		for (const chatId of this.#entries.keys()) {
			if (!activeChatIds.has(chatId)) this.#entries.delete(chatId);
		}
	}

	#entry(chatId: string): ConversationTranscriptOverlayEntry {
		const existing = this.#entries.get(chatId);
		if (existing) return existing;
		const created = new ConversationTranscriptOverlayEntry();
		this.#entries.set(chatId, created);
		return created;
	}
}
