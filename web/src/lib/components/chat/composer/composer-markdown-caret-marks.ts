import { Extension, type JSONContent } from '@tiptap/core';
import { Plugin } from '@tiptap/pm/state';

/**
 * Gives the first text typed at a converted draft's caret the marks its source caret had.
 * Stored marks alone do not hold: when input arrives straight after focus the browser's caret
 * can still sit inside the preceding mark's element, and the marks are then read from the DOM.
 */
export function composerMarkdownCaretMarks(position: number, marks: JSONContent['marks'] = []) {
	return Extension.create({
		name: 'composerMarkdownCaretMarks',
		// Input rules and the table rule see the text first.
		priority: 1,
		addProseMirrorPlugins() {
			const { schema } = this.editor;
			let pending = true;
			let initial: unknown;
			return [
				new Plugin({
					view(view) {
						initial = view.state.doc;
						return {};
					},
					props: {
						handleTextInput(view, from, to, text) {
							if (!pending || view.composing) return false;
							pending = false;
							if (from !== position || to !== position || view.state.doc !== initial) return false;
							view.dispatch(
								view.state.tr
									.setStoredMarks(marks.map((mark) => schema.markFromJSON(mark)))
									.insertText(text, from, to),
							);
							return true;
						},
					},
				}),
			];
		},
	});
}
