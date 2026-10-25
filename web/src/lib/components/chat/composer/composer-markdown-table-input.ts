import { Extension, type JSONContent } from '@tiptap/core';
import { Plugin, TextSelection } from '@tiptap/pm/state';
import { MAX_COMPOSER_MARKDOWN_LENGTH } from './composer-markdown-limits.js';

/** Converts a completed table header and delimiter without reparsing the surrounding draft. */
export function composerMarkdownTableInput(parse: (source: string) => JSONContent) {
	return Extension.create({
		name: 'composerMarkdownTableInput',
		addProseMirrorPlugins() {
			return [
				new Plugin({
					props: {
						handleTextInput(view, from, to, text) {
							if (!view.editable || view.composing || !text.endsWith('|')) return false;
							const transaction = view.state.tr.insertText(text, from, to);
							const head = transaction.selection.$from;
							const paragraph = head.parent;
							if (
								paragraph.type.name !== 'paragraph' ||
								head.parentOffset !== paragraph.content.size ||
								paragraph.content.size > MAX_COMPOSER_MARKDOWN_LENGTH
							)
								return false;
							const source = paragraph.textBetween(0, paragraph.content.size, '\n', '\n');
							const lines = source.split('\n');
							const delimiter = lines.at(-1)!;
							const header = lines.at(-2);
							if (!header?.includes('|') || !/^\s*\|?\s*:?-+:?\s*\|/.test(delimiter)) return false;
							const start = source.length - delimiter.length - header.length - 1;
							// Existing inline formatting and resources remain owned by their document nodes.
							let plain = true;
							paragraph.nodesBetween(start, paragraph.content.size, (node) => {
								if (node.marks.length || (!node.isText && node.type.name !== 'hardBreak'))
									plain = false;
							});
							if (!plain) return false;
							const parsed = parse(`${header}\n${delimiter}`).content;
							if (parsed?.length !== 1 || parsed[0].type !== 'table') return false;
							const table = view.state.schema.nodeFromJSON(parsed[0]);
							const prefix = start > 0 ? paragraph.copy(paragraph.content.cut(0, start - 1)) : null;
							const position = head.before();
							transaction.replaceWith(position, head.after(), prefix ? [prefix, table] : table);
							transaction.setSelection(
								TextSelection.near(
									transaction.doc.resolve(position + (prefix?.nodeSize ?? 0) + table.nodeSize - 1),
									-1,
								),
							);
							view.dispatch(transaction);
							return true;
						},
					},
				}),
			];
		},
	});
}
