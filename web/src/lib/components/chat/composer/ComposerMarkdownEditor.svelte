<script lang="ts">
	import { onMount } from 'svelte';
	import { Editor, resolveFocusPosition, type JSONContent } from '@tiptap/core';
	import { TextSelection } from '@tiptap/pm/state';
	import { closeHistory } from '@tiptap/pm/history';
	import { Placeholder } from '@tiptap/extensions/placeholder';
	import { composerMarkdownCodec } from './composer-markdown-codec.js';
	import { composerMarkdownEditorExtensions } from './composer-markdown-extensions.js';
	import { composerMarkdownTableInput } from './composer-markdown-table-input.js';
	import { composerMarkdownCaretMarks } from './composer-markdown-caret-marks.js';
	import { composerMarkdownEmptyMarks } from './composer-markdown-empty-marks.js';
	import { composerMarkdownNewline } from './composer-markdown-newline.js';
	import { ComposerMarkdownCache } from './composer-markdown-cache.js';
	import {
		MAX_COMPOSER_MARKDOWN_LENGTH,
		MAX_COMPOSER_MARKDOWN_NODES,
	} from './composer-markdown-limits.js';
	import * as m from '$lib/paraglide/messages.js';
	import { createRandomId } from '$lib/utils/random-id.js';
	import type {
		ComposerMarkdownDocument,
		ComposerMarkdownPasteRequest,
	} from './composer-markdown-parser.js';
	import type { ComposerMarkdownMention } from './prompt-composer-markdown-controller.js';
	import {
		findFileMentionTrigger,
		formatFileMentionPath,
	} from '$lib/chat/composer/file-mentions.js';
	import { findSnippetTrigger } from '$lib/chat/composer/snippet-trigger.js';
	import { findSlashCommandTrigger } from '$lib/chat/composer/slash-commands.js';
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
		onSourceAction,
		onSnippet,
		onComposerKeydown,
		onCompletionKeydown,
		onReady,
		onMention,
		onLargePaste,
		onMarkdownPaste,
		onOverflow,
	}: {
		document: JSONContent;
		sources: (string | null)[];
		selection?: number;
		selectionMarks?: JSONContent['marks'];
		readOnly: boolean;
		snippetTrigger: string;
		onChange: (source: string) => void;
		onSourceAction: (text: string, caret: number) => void;
		onSnippet: (text: string, caret: number) => boolean;
		onComposerKeydown: (event: KeyboardEvent) => void;
		onCompletionKeydown: (event: KeyboardEvent) => boolean;
		onReady: (target: HTMLElement) => void;
		onMention: (mention: ComposerMarkdownMention | null) => void;
		onLargePaste: (request: ComposerMarkdownPasteRequest) => void;
		onMarkdownPaste: (
			source: string,
			caret: number,
			apply: (parsed: ComposerMarkdownDocument) => void,
		) => void;
		onOverflow: (source: string) => void;
	} = $props();
	let container: HTMLDivElement;
	let editor: Editor | undefined = $state.raw();
	onMount(() => {
		const extensions = composerMarkdownEditorExtensions();
		const cache = new ComposerMarkdownCache(composerMarkdownCodec.serialize);
		const topLevel = (doc: DocumentNode) =>
			Array.from({ length: doc.childCount }, (_, index) => doc.child(index));
		let original: DocumentNode[] = [];
		let originalSources: (string | null)[] = [];
		// Native history retains fragments; their source baselines avoid lossy reserialization on Undo.
		const sourceHistory = new WeakMap<
			DocumentNode['content'],
			{ original: DocumentNode[]; sources: (string | null)[] }
		>();
		const rememberSource = (doc: DocumentNode) => {
			sourceHistory.set(doc.content, { original, sources: originalSources });
		};
		const blocks = (doc: DocumentNode): ComposerMarkdownBlock<DocumentNode>[] =>
			planComposerMarkdownBlocks(
				original,
				originalSources,
				topLevel(doc),
				(a, b) => a === b || a.eq(b),
			);
		let mentionOpen = false;
		// Inline leaves take one position each, so text offsets line up with document positions.
		const blockText = (block: DocumentNode) =>
			block.textBetween(0, block.content.size, undefined, (leaf) =>
				leaf.type.name === 'hardBreak' ? '\n' : '\ufffc',
			);
		const serialize = (doc: DocumentNode) =>
			joinComposerMarkdownBlocks(blocks(doc), original.length, (nodes) => cache.run(nodes));
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
		const applyMarkdownPaste = (parsed: ComposerMarkdownDocument) => {
			if (mountedEditor.isDestroyed || parsed.selection === undefined) return;
			mountedEditor.setEditable(true, false);
			const document = mountedEditor.schema.nodeFromJSON(parsed.document);
			const transaction = closeHistory(mountedEditor.state.tr).replaceWith(
				0,
				mountedEditor.state.doc.content.size,
				document.content,
			);
			transaction.setSelection(TextSelection.create(transaction.doc, parsed.selection));
			transaction.setStoredMarks(
				(parsed.selectionMarks ?? []).map((mark) => mountedEditor.schema.markFromJSON(mark)),
			);
			rememberSource(mountedEditor.state.doc);
			original = topLevel(transaction.doc);
			originalSources = parsed.sources;
			rememberSource(transaction.doc);
			mountedEditor.view.dispatch(transaction);
			onReady(mountedEditor.view.dom);
			const boundary = closeHistory(mountedEditor.state.tr);
			if (mountedEditor.view.hasFocus()) boundary.scrollIntoView();
			mountedEditor.view.dispatch(boundary);
		};
		const insertText = (view: Editor['view'], text: string, position?: number) => {
			const head =
				position === undefined ? view.state.selection.$from : view.state.doc.resolve(position);
			let marks = head.marks();
			if (position === undefined) {
				const { selection, storedMarks } = view.state;
				marks =
					storedMarks ?? (selection.empty ? head.marks() : head.marksAcross(selection.$to) ?? []);
			}
			let literal = marks.some((mark) => mark.type.name === 'code');
			for (let depth = head.depth; depth > 0; depth--) {
				const node = head.node(depth);
				if (
					node.type.spec.code ||
					node.type.name === 'tableCell' ||
					node.type.name === 'tableHeader'
				) {
					literal = true;
					break;
				}
			}
			if (!literal) {
				const marker = sourceMarker('garconClipboard');
				const marked = serialize(view.state.tr.insertText(marker, position).doc);
				const start = marked.indexOf(marker);
				if (start >= 0) {
					onMarkdownPaste(marked.replace(marker, () => text), start + text.length, applyMarkdownPaste);
					return;
				}
			}
			if (serialize(view.state.doc).length + text.length <= MAX_COMPOSER_MARKDOWN_LENGTH) {
				view.dispatch(view.state.tr.insertText(text, position));
				return;
			}
			// Carries the bounded selection and its marks into off-thread serialization.
			const marker = sourceMarker('garconClipboard');
			onLargePaste({
				blocks: blocks(view.state.tr.insertText(marker, position).doc).map((block) =>
					'nodes' in block ? { nodes: block.nodes.map((node) => node.toJSON()) } : block,
				),
				originalCount: original.length,
				marker,
				text,
			});
		};
		const mountedEditor: Editor = new Editor({
			element: container,
			extensions: [
				...extensions,
				composerMarkdownEmptyMarks,
				Placeholder.configure({ placeholder: m.chat_composer_reply_placeholder() }),
				composerMarkdownTableInput(composerMarkdownCodec.parse),
				...(initialSelection !== undefined && selectionMarks
					? [composerMarkdownCaretMarks(initialSelection, selectionMarks)]
					: []),
			],
			content: documentContent,
			editable: !readOnly,
			enablePasteRules: false,
			onUpdate: ({ editor: current }) => {
				const { doc, selection } = current.state;
				const source = serialize(doc);
				let nodeCount = 1;
				doc.descendants(() => {
					nodeCount++;
					return nodeCount <= MAX_COMPOSER_MARKDOWN_NODES;
				});
				if (
					source.length > MAX_COMPOSER_MARKDOWN_LENGTH ||
					nodeCount > MAX_COMPOSER_MARKDOWN_NODES
				) {
					onOverflow(source);
					return;
				}
				const only = doc.childCount === 1 ? doc.firstChild : null;
				const sourceCommand =
					only?.type.name === 'paragraph' && only.textContent === source && !current.view.composing;
				if (
					sourceCommand &&
					selection.empty &&
					findSlashCommandTrigger(source, selection.$from.parentOffset)
				) {
					onSourceAction(source, selection.$from.parentOffset);
					return;
				}
				const snippet = snippetSource(current);
				if (!snippet || !onSnippet(snippet.text, snippet.caret)) onChange(source);
			},
			onTransaction: ({ editor: current, transaction }) => {
				// Runs before onUpdate, including history steps that leave an equal document.
				const snapshot = sourceHistory.get(current.state.doc.content);
				if (snapshot) {
					original = snapshot.original;
					originalSources = snapshot.sources;
				} else {
					rememberSource(current.state.doc);
				}
				// Typing opens the menu; a restored draft that ends in a mention does not.
				if (transaction.docChanged || mentionOpen) reportMention(current);
			},
			editorProps: {
				attributes: () => ({
					role: 'textbox',
					tabindex: readOnly ? '-1' : '0',
					'aria-label': m.chat_composer_formatted_markdown(),
					'aria-multiline': 'true',
				}),
				handleKeyDown(_view, event) {
					if (readOnly && event.key === 'Enter') {
						event.preventDefault();
						return true;
					}
					if (event.isComposing || _view.composing || event.keyCode === 229) return false;
					if (onCompletionKeydown(event)) return true;
					// Virtual keyboards replay Enter without reliable modifiers. A replay edits,
					// but never submits or steers:
					// https://github.com/ProseMirror/prosemirror-view/blob/17af0f4b25933933f644a655ad6bb9a0249d7cb5/src/input.ts#L118-L127
					if (event.key === 'Enter' && !event.isTrusted) {
						return mountedEditor.commands.command(composerMarkdownNewline);
					}
					onComposerKeydown(event);
					if (event.key === 'Enter' && !event.defaultPrevented) {
						return mountedEditor.commands.command(composerMarkdownNewline);
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
						// Leaves native IME input alone without running editor keymaps or preventing it.
						if (event.isComposing || _view.composing || event.keyCode === 229) return true;
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
	.composer-markdown-editor :global(p.is-editor-empty:first-child::before) {
		content: attr(data-placeholder);
		color: hsl(var(--muted-foreground));
		float: left;
		height: 0;
		pointer-events: none;
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
