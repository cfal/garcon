<script lang="ts">
	import { onMount } from 'svelte';
	import { Editor, resolveFocusPosition, type JSONContent } from '@tiptap/core';
	import { MarkdownManager } from '@tiptap/markdown';
	import { composerMarkdownEditorExtensions } from './composer-markdown-extensions.js';
	import { MAX_COMPOSER_MARKDOWN_LENGTH } from './composer-markdown-limits.js';
	import * as m from '$lib/paraglide/messages.js';
	import type { ComposerMarkdownPasteRequest } from './composer-markdown-parser.js';

	let {
		document: documentContent,
		readOnly,
		onChange,
		onSubmitKeydown,
		onReady,
		onLargePaste,
	}: {
		document: JSONContent;
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
		const insertText = (view: Editor['view'], text: string, position?: number) => {
			if (view.state.doc.textContent.length + text.length <= MAX_COMPOSER_MARKDOWN_LENGTH) {
				view.dispatch(view.state.tr.insertText(text, position));
				return;
			}
			// Carries the bounded selection and its marks into off-thread serialization.
			const marker = `garconClipboard${crypto.randomUUID().replaceAll('-', '')}`;
			onLargePaste({
				document: view.state.tr.insertText(marker, position).doc.toJSON(),
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
			onUpdate: ({ editor: current }) => onChange(markdown.serialize(current.getJSON())),
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
					if (event.key === 'Enter') onSubmitKeydown(event);
					return event.defaultPrevented;
				},
				handleDOMEvents: {
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
		overflow-wrap: anywhere;
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
		min-width: 32rem;
		table-layout: fixed;
	}
	.composer-markdown-editor :global(th),
	.composer-markdown-editor :global(td) {
		border: 0;
		border-bottom: 1px solid hsl(var(--border));
		padding: 0.75rem 0.5rem;
		vertical-align: top;
		text-align: left;
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
	.composer-markdown-editor :global(li[data-type='taskItem']) {
		display: flex;
		gap: 0.5rem;
	}
	.composer-markdown-editor :global(li[data-type='taskItem'] > div) {
		flex: 1;
	}
</style>
