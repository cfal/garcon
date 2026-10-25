import { Extension } from '@tiptap/core';
import { Plugin } from '@tiptap/pm/state';

export const composerMarkdownEmptyMarks = Extension.create({
	name: 'composerMarkdownEmptyMarks',
	addProseMirrorPlugins() {
		return [
			new Plugin({
				appendTransaction(transactions, previous, current) {
					const { doc, storedMarks } = current;
					if (
						!storedMarks?.length ||
						doc.childCount !== 1 ||
						doc.firstChild?.type.name !== 'paragraph' ||
						doc.firstChild.content.size !== 0 ||
						previous.doc.eq(doc) ||
						transactions.some((transaction) => transaction.getMeta('composition'))
					)
						return;
					// Deletion retains marks in ProseMirror; a cleared draft starts unformatted.
					// Empty containers and temporary IME replacements keep their editing context.
					return current.tr.setStoredMarks([]);
				},
			}),
		];
	},
});
