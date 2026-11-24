export type ConversationRowMembership = Pick<ReadonlySet<string>, 'has'>;

const EMPTY_POSITIONS: ReadonlyMap<string, number> = new Map();

export class ConversationRetainedRowLookup {
	#positions = EMPTY_POSITIONS;

	clear(): ConversationRowMembership {
		this.#positions = EMPTY_POSITIONS;
		return EMPTY_POSITIONS;
	}

	forRows(rows: readonly { readonly id: string }[]): ConversationRowMembership {
		const previous = this.#positions;
		const confirmed = new Map<string, number>();
		this.#positions = confirmed;
		let fallback: Map<string, number> | undefined;
		return {
			has(id) {
				if (confirmed.has(id)) return true;
				let index = previous.get(id);
				// A roll, prepend, optimistic echo or replacement can move or remove a retained row.
				if (index === undefined || rows[index]?.id !== id) {
					if (!fallback) {
						fallback = new Map();
						for (let i = 0; i < rows.length; i++) fallback.set(rows[i].id, i);
					}
					index = fallback.get(id);
					if (index === undefined) return false;
				}
				confirmed.set(id, index);
				return true;
			},
		};
	}
}
