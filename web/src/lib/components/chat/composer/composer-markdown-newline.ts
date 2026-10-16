import type { Command } from '@tiptap/core';

/** Applies the composer's newline intent without replaying its submission shortcut. */
export const composerMarkdownNewline: Command = ({ state, commands, chain }) => {
	if (!state.selection.empty) commands.deleteSelection();
	const { $from } = state.selection;
	const parent = $from.parent;
	if (parent.type.spec.code) {
		if ($from.parentOffset === parent.content.size && parent.textContent.endsWith('\n\n')) {
			return chain().deleteRange({ from: $from.pos - 2, to: $from.pos }).exitCode().run();
		}
		return commands.newlineInCode();
	}
	// The nearest container owns the gesture; an outer list must not split a quoted paragraph.
	const container = $from.depth > 0 ? $from.node(-1).type.name : '';
	if (container === 'tableCell' || container === 'tableHeader') return commands.setHardBreak();
	if (container === 'listItem' || container === 'taskItem') {
		if (commands.splitListItem(container)) return true;
	}
	if (commands.liftEmptyBlock()) return true;
	if (parent.type.name === 'heading') return commands.splitBlock();
	if (parent.isTextblock) {
		if ($from.nodeBefore?.type.name !== 'hardBreak') return commands.setHardBreak();
		commands.deleteRange({ from: $from.pos - 1, to: $from.pos });
		if (!commands.splitBlock()) return false;
		commands.liftEmptyBlock();
		return true;
	}
	return commands.createParagraphNear() || commands.splitBlock();
};
