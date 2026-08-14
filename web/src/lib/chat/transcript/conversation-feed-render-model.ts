import type { ChatDisplayRow } from './active-transcript-state.svelte.js';
import {
	buildConversationFeedRenderModel,
	type ConversationFeedRenderItem,
	type ConversationFeedRenderModel,
} from './conversation-feed-items.js';

export type ConversationFeedRenderModelChange =
	| { kind: 'rebuilt' }
	| { kind: 'unchanged' }
	| {
			kind: 'tail-appended';
			appendedItems: ConversationFeedRenderItem[];
	  };

export interface ConversationFeedRenderModelReconciliation {
	model: ConversationFeedRenderModel;
	change: ConversationFeedRenderModelChange;
}

export class ConversationFeedRenderModelController {
	#surfaceIdentity: string | null = null;
	#rows: ChatDisplayRow[] = [];
	#model: ConversationFeedRenderModel | null = null;

	reconcile(surfaceIdentity: string, rows: ChatDisplayRow[]): ConversationFeedRenderModel {
		return this.reconcileDetailed(surfaceIdentity, rows).model;
	}

	reconcileDetailed(
		surfaceIdentity: string,
		rows: ChatDisplayRow[],
	): ConversationFeedRenderModelReconciliation {
		if (surfaceIdentity !== this.#surfaceIdentity) this.#resetForSurface(surfaceIdentity);
		if (this.#model && this.#sameRows(rows)) {
			this.#rows = rows;
			return { model: this.#model, change: { kind: 'unchanged' } };
		}

		const builtModel = buildConversationFeedRenderModel(rows);
		const appendedItems = this.#appendedTailItems(rows, builtModel.items);
		let model = builtModel;
		if (appendedItems && this.#model) {
			model = { ...builtModel, items: [...this.#model.items, ...appendedItems] };
		}
		this.#rows = rows;
		this.#model = model;
		return {
			model,
			change: appendedItems ? { kind: 'tail-appended', appendedItems } : { kind: 'rebuilt' },
		};
	}

	reset(): void {
		this.#surfaceIdentity = null;
		this.#rows = [];
		this.#model = null;
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
			if (!previous || !next || previous.kind !== next.kind || previous.id !== next.id) {
				return false;
			}
			if (previous.kind === 'message' && next.kind === 'message') {
				if (previous.ordinal !== next.ordinal || previous.message !== next.message) return false;
			} else if (previous !== next) {
				return false;
			}
		}
		return true;
	}

	#appendedTailItems(
		rows: ChatDisplayRow[],
		nextItems: ConversationFeedRenderItem[],
	): ConversationFeedRenderItem[] | null {
		const previousItems = this.#model?.items;
		if (!previousItems || rows.length <= this.#rows.length) return null;
		if (!this.#samePrefix(rows, this.#rows.length)) return null;
		if (nextItems.length <= previousItems.length) return null;
		for (const [index, previous] of previousItems.entries()) {
			const next = nextItems[index];
			if (!next || next.kind !== previous.kind || next.id !== previous.id) return null;
		}
		return nextItems.slice(previousItems.length);
	}
}
