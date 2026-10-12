import StarterKit from '@tiptap/starter-kit';
import { Table, TableKit } from '@tiptap/extension-table';
import Image from '@tiptap/extension-image';
import TaskList from '@tiptap/extension-task-list';
import TaskItem from '@tiptap/extension-task-item';
import { Extension } from '@tiptap/core';

// The stock renderer always writes a three-backtick fence, which a body line of three or more
// backticks would close early. The serializer hands code blocks to this renderer instead.
export const DRAFT_CODE_BLOCK = 'draftCodeBlock';
const DraftCodeBlock = Extension.create({
	name: DRAFT_CODE_BLOCK,
	renderMarkdown(node) {
		const text = typeof node.attrs?.text === 'string' ? node.attrs.text : '';
		const language = typeof node.attrs?.language === 'string' ? node.attrs.language : '';
		const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
		const fence = '`'.repeat(Math.max(3, longest + 1));
		return `${fence}${language}\n${text}\n${fence}`;
	},
});

// Draft resources remain visible as text without fetching or navigating them.
const DraftImage = Image.extend({
	renderHTML({ node }) {
		return ['span', { class: 'draft-image' }, node.attrs.alt || 'Image'];
	},
});

// Unpadded cells preserve code whitespace and keep serialization proportional to the draft.
const DraftTable = Table.extend({
	renderMarkdown(node, helpers) {
		const rows = node.content ?? [];
		if (!rows.length) return '';
		const renderRow = (cells: NonNullable<typeof node.content>) =>
			`| ${cells
				.map((cell) =>
					helpers
						.renderChildren(cell.content ?? [], '\n')
						.replace(/ {2}\r?\n|\r?\n/g, '<br>')
						.trim()
						.replace(/\\.|\|/g, (match) => (match === '|' ? '\\|' : match)),
				)
				.join(' | ')} |`;
		const header = rows[0].content ?? [];
		const delimiter = header.map((cell) => {
			const align = cell.attrs?.align;
			return align === 'left'
				? ':---'
				: align === 'right'
					? '---:'
					: align === 'center'
						? ':---:'
						: '---';
		});
		return [
			renderRow(header),
			`| ${delimiter.join(' | ')} |`,
			...rows.slice(1).map((row) => renderRow(row.content ?? [])),
		].join('\n');
	},
});

export function composerMarkdownEditorExtensions() {
	return [
		StarterKit.configure({
			link: { openOnClick: false, autolink: false, linkOnPaste: false },
			trailingNode: false,
			// Its `++text++` syntax would swallow increments such as `i++ and j++`.
			underline: false,
		}),
		DraftCodeBlock,
		TableKit.configure({ table: false }),
		DraftTable.configure({ resizable: false }),
		DraftImage.configure({ inline: true }),
		TaskList,
		TaskItem.configure({ nested: true }),
	];
}
