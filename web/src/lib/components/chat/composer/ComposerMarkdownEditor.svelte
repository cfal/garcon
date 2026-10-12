<script lang="ts">
	import { onMount } from 'svelte';
	import { Editor, resolveFocusPosition, type JSONContent } from '@tiptap/core';
	import { MarkdownManager } from '@tiptap/markdown';
	import { composerMarkdownEditorExtensions } from './composer-markdown-extensions.js';
	import { MAX_COMPOSER_MARKDOWN_LENGTH } from './composer-markdown-limits.js';
	import * as m from '$lib/paraglide/messages.js';
	import { createRandomId } from '$lib/utils/random-id.js';
	import type { ComposerMarkdownPasteRequest } from './composer-markdown-parser.js';
	import { serializeComposerMarkdown } from './composer-markdown.js';
	import {
		joinComposerMarkdownBlocks,
		planComposerMarkdownBlocks,
		type ComposerMarkdownBlock,
	} from './composer-markdown-blocks.js';

	type DocumentNode = Editor['state']['doc'];

	let {
		document: documentContent,
		sources,
		readOnly,
		onChange,
		onSubmitKeydown,
		onReady,
		onLargePaste,
	}: {
		document: JSONContent;
		sources: (string | null)[];
		readOnly: boolean;
		onChange: (source: string) => void;
		onSubmitKeydown: (event: KeyboardEvent) => void;
		onReady: (target: HTMLElement) => void;
		onLargePaste: (request: ComposerMarkdownPasteRequest) => void;
	} = $props();
	let container: HTMLDivElement;
	let editor: Editor | undefined = $state.raw();
	onMount(() => {
		const extensions = composerMarkdownEditorExtensions();
		const markdown = new MarkdownManager({ extensions });
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
		const insertText = (view: Editor['view'], text: string, position?: number) => {
			if (view.state.doc.textContent.length + text.length <= MAX_COMPOSER_MARKDOWN_LENGTH) {
				view.dispatch(view.state.tr.insertText(text, position));
				return;
			}
			// Carries the bounded selection and its marks into off-thread serialization.
			// `crypto.randomUUID` is unavailable on the plain HTTP origins Garcon supports.
			const marker = `garconClipboard${createRandomId().replaceAll('-', '')}`;
			onLargePaste({
				blocks: blocks(view.state.tr.insertText(marker, position).doc),
				originalCount: original.length,
				marker,
				text,
			});
		};
		const mountedEditor = new Editor({
			element: container,
			extensions,
			content: documentContent,
			editable: !readOnly,
			enableInputRules: false,
			enablePasteRules: false,
			onUpdate: ({ editor: current }) =>
				onChange(
					joinComposerMarkdownBlocks(blocks(current.state.doc), original.length, (nodes) =>
						serializeComposerMarkdown(markdown, { type: 'doc', content: nodes }),
					),
				),
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
					if (event.key === 'Enter') onSubmitKeydown(event);
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
		originalSources =
			sources.length === original.length ? sources : original.map(() => null);
		const selection = resolveFocusPosition(mountedEditor.state.doc, 'end');
		if (selection) mountedEditor.view.dispatch(mountedEditor.state.tr.setSelection(selection));
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
