import { HorizontalRule } from '@tiptap/extension-horizontal-rule';
import { Link } from '@tiptap/extension-link';
import { ListKeymap } from '@tiptap/extension-list/keymap';
import { Dropcursor } from '@tiptap/extensions/drop-cursor';
import { Gapcursor } from '@tiptap/extensions/gap-cursor';
import { UndoRedo } from '@tiptap/extensions/undo-redo';
import {
	composerLinkMarkdown,
	composerMarkdownCodecExtensions,
} from './composer-markdown-codec-extensions.js';

export function composerMarkdownEditorExtensions() {
	return composerMarkdownCodecExtensions().flatMap((extension) => {
		switch (extension.name) {
			case 'doc':
				return [extension, Dropcursor, Gapcursor];
			case 'heading':
				return [extension, UndoRedo];
			case 'horizontalRule':
				// Typed dividers stay literal; other extensions use their native input rules.
				return [HorizontalRule.extend({ addInputRules: () => [] })];
			case 'listItem':
				return [extension, ListKeymap];
			case 'link':
				return [
					Link.extend(composerLinkMarkdown).configure({
						openOnClick: false,
						autolink: false,
						linkOnPaste: false,
						markdownLinks: true,
					}),
				];
			default:
				return [extension];
		}
	});
}
