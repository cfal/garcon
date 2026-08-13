import { AssistantMessage, BashToolUseMessage, ReadToolUseMessage } from '$shared/chat-types';
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

export type ConversationFeedRenderModelChange =
	| { kind: 'rebuilt' }
	| { kind: 'unchanged' }
	| {
			kind: 'tail-appended';
			appendedItems: ReconciledConversationFeedRenderItem[];
	  };

export interface ConversationFeedRenderModelReconciliation {
	model: ReconciledConversationFeedRenderModel;
	change: ConversationFeedRenderModelChange;
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
	#rows: ChatDisplayRow[] = [];
	#model: ReconciledConversationFeedRenderModel | null = null;
	#runByMember = new Map<string, PriorRun>();
	#runOrderById = new Map<string, number>();
	#nextRunSerial = 0;

	reconcile(
		surfaceIdentity: string,
		rows: ChatDisplayRow[],
	): ReconciledConversationFeedRenderModel {
		return this.reconcileDetailed(surfaceIdentity, rows).model;
	}

	reconcileDetailed(
		surfaceIdentity: string,
		rows: ChatDisplayRow[],
	): ConversationFeedRenderModelReconciliation {
		if (surfaceIdentity !== this.#surfaceIdentity) this.#resetForSurface(surfaceIdentity);
		if (this.#model) {
			if (this.#sameRows(rows)) {
				this.#rows = rows;
				return { model: this.#model, change: { kind: 'unchanged' } };
			}

			const appended = this.#appendAssistantTail(rows);
			if (appended) return appended;
		}

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
		const reconciled = { ...model, items };
		this.#rows = rows;
		this.#model = reconciled;
		return { model: reconciled, change: { kind: 'rebuilt' } };
	}

	reset(): void {
		this.#surfaceIdentity = null;
		this.#rows = [];
		this.#model = null;
		this.#runByMember.clear();
		this.#runOrderById.clear();
		this.#nextRunSerial = 0;
	}

	#resetForSurface(surfaceIdentity: string): void {
		this.reset();
		this.#surfaceIdentity = surfaceIdentity;
	}

	#sameRows(rows: ChatDisplayRow[]): boolean {
		return rows.length === this.#rows.length && this.#samePrefix(rows, rows.length);
	}

	#samePrefix(rows: ChatDisplayRow[], count: number): boolean {
		for (let index = 0; index < count; index += 1) {
			const previous = this.#rows[index];
			const next = rows[index];
			if (!previous || !next || previous.kind !== next.kind || previous.id !== next.id)
				return false;
			if (previous.kind === 'message' && next.kind === 'message') {
				if (previous.ordinal !== next.ordinal || previous.message !== next.message) return false;
			} else if (previous !== next) {
				return false;
			}
		}
		return true;
	}

	#appendAssistantTail(rows: ChatDisplayRow[]): ConversationFeedRenderModelReconciliation | null {
		if (!this.#model || rows.length <= this.#rows.length) return null;
		if (!this.#samePrefix(rows, this.#rows.length)) return null;
		const appendedRows = rows.slice(this.#rows.length);
		if (
			appendedRows.some(
				(row) => row.kind !== 'message' || !(row.message instanceof AssistantMessage),
			)
		) {
			return null;
		}

		let previousRenderable = this.#lastRenderableMessage();
		const appendedItems = appendedRows.map((row, offset): ReconciledConversationFeedRenderItem => {
			if (row.kind !== 'message') throw new Error('Expected an assistant transcript row');
			const item: ReconciledConversationFeedRenderItem = {
				kind: 'message',
				id: row.id,
				rowIds: [row.id],
				message: row.message,
				index: this.#rows.length + offset,
				ordinal: row.ordinal,
				prevMessage: previousRenderable,
				virtualKey: row.id,
			};
			previousRenderable = row.message;
			return item;
		});
		const model = { ...this.#model, items: [...this.#model.items, ...appendedItems] };
		this.#rows = rows;
		this.#model = model;
		return {
			model,
			change: { kind: 'tail-appended', appendedItems },
		};
	}

	#lastRenderableMessage() {
		const item = this.#model?.items.at(-1);
		if (!item || item.kind === 'local-notice') return null;
		if (item.kind === 'message') return item.message;
		return item.rows.at(-1)?.message ?? null;
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
