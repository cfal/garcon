<script lang="ts">
	import { lazyRenderer } from '$lib/utils/lazy-renderer.js';
	import * as m from '$lib/paraglide/messages.js';
	import type {
		ComposerMarkdownDocument,
		ComposerMarkdownPasteRequest,
	} from './composer-markdown-parser.js';
	let {
		draft,
		readOnly,
		onChange,
		onEditSource,
		onSubmitKeydown,
		onReady,
		onLargePaste,
	}: {
		draft: { source: string } & ComposerMarkdownDocument;
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
		class="max-h-[min(40dvh,150px)] overflow-auto whitespace-pre-wrap px-4 py-3 text-base text-composer-foreground sm:max-h-[min(40dvh,300px)] sm:px-5">{draft.source}</pre>
{:then MarkdownEditor}
	<MarkdownEditor document={draft.document} sources={draft.sources} {readOnly} {onChange} {onSubmitKeydown} {onReady} {onLargePaste} />
{:catch}
	<button type="button" onclick={onEditSource} class="px-4 py-3 text-sm text-muted-foreground"
		>{m.chat_composer_format_unavailable()}</button
	>
{/await}
