import type { Command } from '@tiptap/core';
import { NodeSelection } from '@tiptap/pm/state';

/** Applies the composer's newline intent without replaying its submission shortcut. */
export const composerMarkdownNewline: Command = ({ state, commands, chain }) => {
	const { selection } = state;
	if (selection instanceof NodeSelection && selection.node.isBlock) {
		return commands.createParagraphNear() || commands.splitBlock();
	}
	const { $from } = selection;
	const parent = $from.parent;
	if (parent.type.spec.code) {
		if (
			selection.empty &&
			$from.parentOffset === parent.content.size &&
			parent.textContent.endsWith('\n\n')
		) {
			return chain()
				.deleteRange({ from: $from.pos - 2, to: $from.pos })
				.exitCode()
				.run();
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
		if (!selection.empty || $from.nodeBefore?.type.name !== 'hardBreak')
			return commands.setHardBreak();
		commands.deleteRange({ from: $from.pos - 1, to: $from.pos });
		if (!commands.splitBlock()) return false;
		commands.liftEmptyBlock();
		return true;
	}
	return commands.createParagraphNear() || commands.splitBlock();
};
