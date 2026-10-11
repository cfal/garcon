<script lang="ts">
	import type { JSONContent } from '@tiptap/core';
	import { lazyRenderer } from '$lib/utils/lazy-renderer.js';
	import * as m from '$lib/paraglide/messages.js';
	import type { ComposerMarkdownPasteRequest } from './composer-markdown-parser.js';
	let {
		source,
		document,
		readOnly,
		onChange,
		onEditSource,
		onSubmitKeydown,
		onReady,
		onLargePaste,
	}: {
		source: string;
		document: JSONContent;
		readOnly: boolean;
		onChange: (source: string) => void;
		onEditSource: () => void;
		onSubmitKeydown: (event: KeyboardEvent) => void;
		onReady: (target: HTMLElement) => void;
		onLargePaste: (request: ComposerMarkdownPasteRequest) => void;
	} = $props();
	const renderer = lazyRenderer(() => import('./ComposerMarkdownEditor.svelte'));
</script>

{#await renderer()}
	<pre
		class="max-h-[min(40dvh,150px)] overflow-auto whitespace-pre-wrap px-4 py-3 text-base text-composer-foreground sm:max-h-[min(40dvh,300px)] sm:px-5">{source}</pre>
{:then MarkdownEditor}
	<MarkdownEditor {document} {readOnly} {onChange} {onSubmitKeydown} {onReady} {onLargePaste} />
{:catch}
	<button type="button" onclick={onEditSource} class="px-4 py-3 text-sm text-muted-foreground"
		>{m.chat_composer_format_unavailable()}</button
	>
{/await}
