<script lang="ts">
	import { onMount } from 'svelte';
	import { Editor, resolveFocusPosition, type JSONContent } from '@tiptap/core';
	import { TextSelection } from '@tiptap/pm/state';
	import { MarkdownManager } from '@tiptap/markdown';
	import { composerMarkdownEditorExtensions } from './composer-markdown-extensions.js';
	import { composerMarkdownTableInput } from './composer-markdown-table-input.js';
	import { composerMarkdownCaretMarks } from './composer-markdown-caret-marks.js';
	import { MAX_COMPOSER_MARKDOWN_LENGTH } from './composer-markdown-limits.js';
	import * as m from '$lib/paraglide/messages.js';
	import { createRandomId } from '$lib/utils/random-id.js';
	import type { ComposerMarkdownPasteRequest } from './composer-markdown-parser.js';
	import type { ComposerMarkdownMention } from './prompt-composer-markdown-controller.js';
	import {
		findFileMentionTrigger,
		formatFileMentionPath,
	} from '$lib/chat/composer/file-mentions.js';
	import { findSnippetTrigger } from '$lib/chat/composer/snippet-trigger.js';
	import { configureComposerMarkdown, serializeComposerMarkdown } from './composer-markdown.js';
	import {
		joinComposerMarkdownBlocks,
		planComposerMarkdownBlocks,
		type ComposerMarkdownBlock,
	} from './composer-markdown-blocks.js';

	type DocumentNode = Editor['state']['doc'];

	let {
		document: documentContent,
		sources,
		selection: initialSelection,
		selectionMarks,
		readOnly,
		snippetTrigger,
		onChange,
		onPlain,
		onSnippet,
		onEditSource,
		onSubmitKeydown,
		onCompletionKeydown,
		onReady,
		onMention,
		onLargePaste,
	}: {
		document: JSONContent;
		sources: (string | null)[];
		selection?: number;
		selectionMarks?: JSONContent['marks'];
		readOnly: boolean;
		snippetTrigger: string;
		onChange: (source: string) => void;
		onPlain: (text: string, caret: number) => void;
		onSnippet: (text: string, caret: number) => boolean;
		onEditSource: () => void;
		onSubmitKeydown: (event: KeyboardEvent) => void;
		onCompletionKeydown: (event: KeyboardEvent) => boolean;
		onReady: (target: HTMLElement) => void;
		onMention: (mention: ComposerMarkdownMention | null) => void;
		onLargePaste: (request: ComposerMarkdownPasteRequest) => void;
	} = $props();
	let container: HTMLDivElement;
	let editor: Editor | undefined = $state.raw();
	onMount(() => {
		const extensions = composerMarkdownEditorExtensions();
		const markdown = new MarkdownManager({ extensions });
		configureComposerMarkdown(markdown);
		const topLevel = (doc: DocumentNode) =>
			Array.from({ length: doc.childCount }, (_, index) => doc.child(index));
		let original: DocumentNode[] = [];
		let originalSources: (string | null)[] = [];
		const blocks = (doc: DocumentNode): ComposerMarkdownBlock<JSONContent>[] =>
			planComposerMarkdownBlocks(
				original,
				originalSources,
				topLevel(doc),
				(a, b) => a === b || a.eq(b),
			).map((block) =>
				'nodes' in block ? { nodes: block.nodes.map((node) => node.toJSON()) } : block,
			);
		// Records Shift from real key events for the synthetic Enter described below.
		let shiftHeld = false;
		let mentionOpen = false;
		// Inline leaves take one position each, so text offsets line up with document positions.
		const blockText = (block: DocumentNode) =>
			block.textBetween(0, block.content.size, undefined, (leaf) =>
				leaf.type.name === 'hardBreak' ? '\n' : '\ufffc',
			);
		const serialize = (doc: DocumentNode) =>
			joinComposerMarkdownBlocks(blocks(doc), original.length, (nodes) =>
				serializeComposerMarkdown(markdown, { type: 'doc', content: nodes }),
			);
		// `crypto.randomUUID` is unavailable on the plain HTTP origins Garcon supports.
		const sourceMarker = (prefix: string) => `${prefix}${createRandomId().replaceAll('-', '')}`;
		// The snippet palette replaces a range of the source, which only the plain editor can
		// address, so a trigger typed here is located in the source the draft serializes to.
		const snippetSource = (current: Editor): { text: string; caret: number } | null => {
			const { selection } = current.state;
			const head = selection.$from;
			if (
				!selection.empty ||
				!head.parent.isTextblock ||
				current.view.composing ||
				!findSnippetTrigger(blockText(head.parent), head.parentOffset, snippetTrigger)
			)
				return null;
			const marker = sourceMarker('garconSnippet');
			const marked = serialize(current.state.tr.insertText(marker).doc);
			const caret = marked.indexOf(marker);
			if (caret < 0) return null;
			return { text: marked.slice(0, caret) + marked.slice(caret + marker.length), caret };
		};
		const reportMention = (current: Editor) => {
			const { selection } = current.state;
			const head = selection.$from;
			const block = head.parent;
			const inCode = block.type.spec.code || head.marks().some((mark) => mark.type.name === 'code');
			const text = blockText(block);
			const trigger =
				current.isEditable && selection.empty && block.isTextblock && !inCode
					? findFileMentionTrigger(text, head.parentOffset)
					: null;
			if (!trigger) {
				if (mentionOpen) onMention(null);
				mentionOpen = false;
				return;
			}
			mentionOpen = true;
			const start = head.start();
			onMention({
				query: trigger.query,
				insert(path) {
					// Mirrors the plain editor: one space follows the mention unless the line ends there.
					const after = text.slice(trigger.end);
					const lineEnd = after.startsWith('\n');
					const skipped = lineEnd ? 0 : (/^[ \t]*/.exec(after)?.[0].length ?? 0);
					current
						.chain()
						.insertContentAt(
							{ from: start + trigger.start, to: start + trigger.end + skipped },
							{ type: 'text', text: `@${formatFileMentionPath(path)}${lineEnd ? '' : ' '}` },
						)
						.focus()
						.run();
				},
			});
		};
		const insertText = (view: Editor['view'], text: string, position?: number) => {
			if (view.state.doc.textContent.length + text.length <= MAX_COMPOSER_MARKDOWN_LENGTH) {
				view.dispatch(view.state.tr.insertText(text, position));
				return;
			}
			// Carries the bounded selection and its marks into off-thread serialization.
			const marker = sourceMarker('garconClipboard');
			onLargePaste({
				blocks: blocks(view.state.tr.insertText(marker, position).doc),
				originalCount: original.length,
				marker,
				text,
			});
		};
		const mountedEditor = new Editor({
			element: container,
			extensions: [
				...extensions,
				composerMarkdownTableInput((source) => markdown.parse(source)),
				...(initialSelection !== undefined && selectionMarks
					? [composerMarkdownCaretMarks(initialSelection, selectionMarks)]
					: []),
			],
			content: documentContent,
			editable: !readOnly,
			enableInputRules: [
				'bold',
				'italic',
				'strike',
				'code',
				'link',
				'image',
				'heading',
				'blockquote',
				'bulletList',
				'orderedList',
				'taskItem',
				'codeBlock',
			],
			enablePasteRules: false,
			onUpdate: ({ editor: current }) => {
				const { doc, selection } = current.state;
				const source = serialize(doc);
				const only = doc.childCount === 1 ? doc.firstChild : null;
				// With no formatting left the plain editor takes over, where commands and recall work.
				const plain =
					only?.type.name === 'paragraph' && only.textContent === source && !current.view.composing;
				if (plain) {
					onPlain(source, selection.empty ? selection.$from.parentOffset : source.length);
					return;
				}
				const snippet = snippetSource(current);
				if (!snippet || !onSnippet(snippet.text, snippet.caret)) onChange(source);
			},
			onTransaction: ({ editor: current, transaction }) => {
				// Typing opens the menu; a restored draft that ends in a mention does not.
				if (transaction.docChanged || mentionOpen) reportMention(current);
			},
			editorProps: {
				attributes: {
					role: 'textbox',
					'aria-label': m.chat_composer_formatted_markdown(),
					'aria-multiline': 'true',
				},
				handleKeyDown(_view, event) {
					if (readOnly && event.key === 'Enter') {
						event.preventDefault();
						return true;
					}
					// iOS replays Enter as a synthetic event without modifiers, so Shift+Enter
					// would read as Enter:
					// https://github.com/ProseMirror/prosemirror-view/blob/17af0f4b25933933f644a655ad6bb9a0249d7cb5/src/input.ts#L118-L127
					if (event.key === 'Enter' && !event.isTrusted && shiftHeld && !event.shiftKey) {
						return false;
					}
					if (onCompletionKeydown(event)) return true;
					const undo =
						(event.ctrlKey || event.metaKey) &&
						!event.shiftKey &&
						!event.altKey &&
						event.key.toLowerCase() === 'z';
					// With no edit to undo, undo steps out of the formatted view to the paste behind it.
					if (undo && !mountedEditor.can().undo() && !mountedEditor.can().redo()) {
						event.preventDefault();
						onEditSource();
						return true;
					}
					if (event.key === 'Enter') {
						onSubmitKeydown(event);
						if (!event.defaultPrevented) {
							const item = mountedEditor.isActive('taskItem') ? 'taskItem' : 'listItem';
							if (mountedEditor.isActive(item) && mountedEditor.commands.splitListItem(item))
								return true;
						}
					}
					return event.defaultPrevented;
				},
				handleDOMEvents: {
					// ProseMirror applies its selection 20 ms after focus; until then the browser's
					// caret sits at the document start and immediate input would land there.
					focus(view) {
						view.focus();
						return false;
					},
					keydown(_view, event) {
						shiftHeld = event.shiftKey;
						return false;
					},
					keyup(_view, event) {
						if (event.key === 'Shift') shiftHeld = false;
						return false;
					},
					paste(view, event) {
						event.preventDefault();
						const text = event.clipboardData?.getData('text/plain');
						if (!readOnly && text) insertText(view, text);
						return true;
					},
					drop(view, event) {
						if (!readOnly && view.dragging) return false;
						event.preventDefault();
						const text = event.dataTransfer?.getData('text/plain');
						if (!readOnly && !event.dataTransfer?.files.length && text) {
							const position = view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos;
							insertText(view, text, position);
						}
						return true;
					},
					click(_view, event) {
						if ((event.target as Element).closest('a')) event.preventDefault();
						return false;
					},
				},
			},
		});
		editor = mountedEditor;
		original = topLevel(mountedEditor.state.doc);
		originalSources = sources.length === original.length ? sources : original.map(() => null);
		const selection =
			initialSelection === undefined
				? resolveFocusPosition(mountedEditor.state.doc, 'end')
				: TextSelection.create(mountedEditor.state.doc, initialSelection);
		if (selection) mountedEditor.view.dispatch(mountedEditor.state.tr.setSelection(selection));
		if (selectionMarks)
			mountedEditor.view.dispatch(
				mountedEditor.state.tr.setStoredMarks(
					selectionMarks.map((mark) => mountedEditor.schema.markFromJSON(mark)),
				),
			);
		onReady(mountedEditor.view.dom);
		return () => mountedEditor.destroy();
	});
	$effect(() => {
		editor?.setEditable(!readOnly, false);
	});
</script>

<div
	bind:this={container}
	data-composer-markdown-editor
	class="composer-markdown-editor max-h-[min(40dvh,150px)] overflow-auto px-4 py-3 text-base leading-6 text-composer-foreground sm:max-h-[min(40dvh,300px)] sm:px-5 sm:py-3.5"
></div>

<style>
	.composer-markdown-editor :global(.tiptap) {
		outline: none;
		/* Keeps whole words in table columns; `anywhere` would let columns shrink mid-word. */
		overflow-wrap: break-word;
		white-space: pre-wrap;
	}
	.composer-markdown-editor :global(p) {
		margin: 0;
	}
	.composer-markdown-editor :global(.tiptap > * + *) {
		margin-top: 0.75rem;
	}
	.composer-markdown-editor :global(h1),
	.composer-markdown-editor :global(h2),
	.composer-markdown-editor :global(h3) {
		font-size: 1em;
		font-weight: 600;
	}
	.composer-markdown-editor :global(ul),
	.composer-markdown-editor :global(ol) {
		padding-left: 1.5rem;
	}
	.composer-markdown-editor :global(ul) {
		list-style: disc;
	}
	.composer-markdown-editor :global(ol) {
		list-style: decimal;
	}
	.composer-markdown-editor :global(blockquote) {
		border-left: 2px solid hsl(var(--border));
		padding-left: 0.75rem;
	}
	.composer-markdown-editor :global(a) {
		color: hsl(var(--primary));
		text-decoration: underline;
	}
	.composer-markdown-editor :global(code) {
		font-family: monospace;
		background: hsl(var(--muted));
		border-radius: 0.25rem;
		padding: 0.1rem 0.25rem;
	}
	.composer-markdown-editor :global(pre) {
		background: hsl(var(--muted));
		border-radius: 0.5rem;
		padding: 0.75rem;
		overflow: auto;
	}
	.composer-markdown-editor :global(pre code) {
		padding: 0;
	}
	.composer-markdown-editor :global(table) {
		border-collapse: collapse;
		width: 100%;
		/* Sizes columns by content so short columns leave room for prose. */
		table-layout: auto;
	}
	.composer-markdown-editor :global(th),
	.composer-markdown-editor :global(td) {
		border: 0;
		border-bottom: 1px solid hsl(var(--border));
		min-width: 2.5rem;
		padding: 0.625rem 0.75rem;
		vertical-align: top;
		text-align: left;
	}
	/* Aligns the table's text with the surrounding paragraphs. */
	.composer-markdown-editor :global(:is(th, td):first-child) {
		padding-left: 0;
	}
	.composer-markdown-editor :global(:is(th, td):last-child) {
		padding-right: 0;
	}
	.composer-markdown-editor :global(tr:last-child td) {
		border-bottom: 0;
	}
	.composer-markdown-editor :global(th) {
		font-weight: 600;
	}
	.composer-markdown-editor :global(.selectedCell) {
		background: hsl(var(--accent));
	}
	.composer-markdown-editor :global(ul[data-type='taskList']) {
		list-style: none;
		padding-left: 0;
	}
	/* The task item node view renders a bare `li` holding a label and a content block. */
	.composer-markdown-editor :global(ul[data-type='taskList'] > li) {
		display: flex;
		align-items: baseline;
		gap: 0.5rem;
	}
	.composer-markdown-editor :global(ul[data-type='taskList'] > li > div) {
		flex: 1;
		min-width: 0;
	}
</style>
