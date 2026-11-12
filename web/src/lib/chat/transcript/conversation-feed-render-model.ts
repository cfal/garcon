import type { ChatDisplayRow } from './active-transcript-state.svelte.js';
import {
	buildConversationFeedRenderModel,
	ConversationToolPairing,
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

function canAppendWithoutRevision(row: ChatDisplayRow): boolean {
	// Commands can revise earlier output; local notices depend on the final durable row.
	return row.kind === 'message'
		&& row.message.type !== 'command-output'
		&& row.message.type !== 'command-result'
		&& row.message.type !== 'transcript-notice';
}

export class ConversationFeedRenderModelController {
	#surfaceIdentity: string | null = null;
	#rows: ChatDisplayRow[] = [];
	#model: ConversationFeedRenderModel | null = null;
	#pairing = new ConversationToolPairing();
	#hasLocalNotices = false;

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

		const extendsPrevious = this.#model !== null
			&& rows.length > this.#rows.length
			&& this.#samePrefix(rows, this.#rows.length);
		if (this.#model && extendsPrevious && !this.#hasLocalNotices) {
			const appended = this.#appendTailModel(this.#model, rows);
			if (appended) return appended;
		}
		this.#pairing = new ConversationToolPairing();
		const builtModel = buildConversationFeedRenderModel(rows, this.#pairing);
		this.#hasLocalNotices = rows.some(row => row.kind === 'local-notice');
		const appendedItems = extendsPrevious ? this.#appendedTailItems(builtModel.items) : null;
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
		this.#pairing = new ConversationToolPairing();
		this.#hasLocalNotices = false;
	}

	#resetForSurface(surfaceIdentity: string): void {
		this.reset();
		this.#surfaceIdentity = surfaceIdentity;
	}

	#appendTailModel(
		previous: ConversationFeedRenderModel,
		rows: ChatDisplayRow[],
	): ConversationFeedRenderModelReconciliation | null {
		const appendedRows = rows.slice(this.#rows.length);
		if (!appendedRows.every(canAppendWithoutRevision)) return null;

		const suffix = buildConversationFeedRenderModel(appendedRows, this.#pairing);
		const appendedItems = suffix.items.map((item) => ({
			...item,
			index: item.index + this.#rows.length,
		}));
		const terminals = suffix.permissionTerminalByOccurrence.size === 0
			? previous.permissionTerminalByOccurrence
			: new Map([
				...previous.permissionTerminalByOccurrence,
				...suffix.permissionTerminalByOccurrence,
			]);
		this.#model = {
			...suffix,
			items: [...previous.items, ...appendedItems],
			permissionTerminalByOccurrence: terminals,
		};
		this.#rows = rows;
		return { model: this.#model, change: { kind: 'tail-appended', appendedItems } };
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
				if (previous.ordinal !== next.ordinal || previous.message !== next.message
					|| previous.awaitingDelivery !== next.awaitingDelivery) return false;
			} else if (previous !== next) {
				return false;
			}
		}
		return true;
	}

	#appendedTailItems(
		nextItems: ConversationFeedRenderItem[],
	): ConversationFeedRenderItem[] | null {
		const previousItems = this.#model?.items;
		if (!previousItems || nextItems.length <= previousItems.length) return null;
		for (const [index, previous] of previousItems.entries()) {
			const next = nextItems[index];
			if (!next || next.kind !== previous.kind || next.id !== previous.id) return null;
			if (previous.kind === 'message' && next.kind === 'message'
				&& previous.message !== next.message) return null;
			if (previous.kind === 'local-notice' && next.kind === 'local-notice'
				&& previous.duplicateOfRowId !== next.duplicateOfRowId) return null;
		}
		return nextItems.slice(previousItems.length);
	}
}
