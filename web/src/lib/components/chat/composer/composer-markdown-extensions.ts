import StarterKit from '@tiptap/starter-kit';
import { Table, TableKit } from '@tiptap/extension-table';
import Image from '@tiptap/extension-image';
import TaskList from '@tiptap/extension-task-list';
import TaskItem from '@tiptap/extension-task-item';

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
		TableKit.configure({ table: false }),
		DraftTable.configure({ resizable: false }),
		DraftImage.configure({ inline: true }),
		TaskList,
		TaskItem.configure({ nested: true }),
	];
}
