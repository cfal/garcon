import { BashToolUseMessage, ReadToolUseMessage } from '$shared/chat-types';
import type { ChatDisplayRow } from './active-transcript-state.svelte.js';
import {
	buildConversationFeedRenderModel,
	type ConversationFeedRenderItem,
	type ConversationFeedRenderModel,
} from './conversation-feed-items.js';

type RunKind = 'bash' | 'read';

export type ReconciledConversationFeedRenderItem = ConversationFeedRenderItem & {
	virtualKey: string;
};

export interface ReconciledConversationFeedRenderModel extends Omit<
	ConversationFeedRenderModel,
	'items'
> {
	items: ReconciledConversationFeedRenderItem[];
}

interface PriorRun {
	kind: RunKind;
	id: string;
}

interface RunCandidate {
	nextIndex: number;
	priorId: string;
	overlap: number;
	priorOrder: number;
}

function runKind(item: ConversationFeedRenderItem): RunKind | null {
	if (item.kind === 'bash-group') return 'bash';
	if (item.kind === 'read-group') return 'read';
	if (item.kind !== 'message') return null;
	if (item.message instanceof BashToolUseMessage) return 'bash';
	if (item.message instanceof ReadToolUseMessage) return 'read';
	return null;
}

export class ConversationFeedRenderModelController {
	#surfaceIdentity: string | null = null;
	#runByMember = new Map<string, PriorRun>();
	#runOrderById = new Map<string, number>();
	#nextRunSerial = 0;

	reconcile(
		surfaceIdentity: string,
		rows: ChatDisplayRow[],
	): ReconciledConversationFeedRenderModel {
		if (surfaceIdentity !== this.#surfaceIdentity) this.#resetForSurface(surfaceIdentity);

		const model = buildConversationFeedRenderModel(rows);
		const candidates = this.#candidates(model.items);
		const assignedPriorIds = new Set<string>();
		const priorIdByNextIndex = new Map<number, string>();

		for (const candidate of candidates) {
			if (assignedPriorIds.has(candidate.priorId) || priorIdByNextIndex.has(candidate.nextIndex)) {
				continue;
			}
			assignedPriorIds.add(candidate.priorId);
			priorIdByNextIndex.set(candidate.nextIndex, candidate.priorId);
		}

		const nextRunByMember = new Map<string, PriorRun>();
		const items = model.items.map((item, nextIndex): ReconciledConversationFeedRenderItem => {
			const kind = runKind(item);
			if (!kind) return { ...item, virtualKey: item.id };

			const priorId = priorIdByNextIndex.get(nextIndex);
			const virtualKey = priorId ?? `${kind}-run-${++this.#nextRunSerial}`;
			for (const rowId of item.rowIds) {
				nextRunByMember.set(rowId, { kind, id: virtualKey });
			}
			return { ...item, virtualKey };
		});

		this.#runByMember = nextRunByMember;
		this.#runOrderById = new Map(
			items.flatMap((item, index) => (runKind(item) ? ([[item.virtualKey, index]] as const) : [])),
		);
		return { ...model, items };
	}

	reset(): void {
		this.#surfaceIdentity = null;
		this.#runByMember.clear();
		this.#runOrderById.clear();
		this.#nextRunSerial = 0;
	}

	#resetForSurface(surfaceIdentity: string): void {
		this.reset();
		this.#surfaceIdentity = surfaceIdentity;
	}

	#candidates(items: ConversationFeedRenderItem[]): RunCandidate[] {
		const candidates: RunCandidate[] = [];
		for (const [nextIndex, item] of items.entries()) {
			const kind = runKind(item);
			if (!kind) continue;
			const overlapById = new Map<string, number>();
			for (const rowId of item.rowIds) {
				const prior = this.#runByMember.get(rowId);
				if (!prior || prior.kind !== kind) continue;
				overlapById.set(prior.id, (overlapById.get(prior.id) ?? 0) + 1);
			}
			for (const [priorId, overlap] of overlapById) {
				candidates.push({
					nextIndex,
					priorId,
					overlap,
					priorOrder: this.#runOrderById.get(priorId) ?? Number.MAX_SAFE_INTEGER,
				});
			}
		}

		return candidates.sort(
			(left, right) =>
				right.overlap - left.overlap ||
				left.priorOrder - right.priorOrder ||
				left.nextIndex - right.nextIndex ||
				left.priorId.localeCompare(right.priorId),
		);
	}
}
