<script lang="ts">
	import * as m from '$lib/paraglide/messages.js';
	import { loadComposerMarkdownEditor } from './composer-markdown-editor-loader.js';
	import type { ComposerMarkdownDocument } from './composer-markdown-parser.js';
	import type { PromptComposerMarkdownController } from './prompt-composer-markdown-controller.js';
	let {
		draft,
		readOnly,
		controller,
		onSubmitKeydown,
		onCompletionKeydown,
	}: {
		draft: { source: string } & ComposerMarkdownDocument;
		readOnly: boolean;
		controller: PromptComposerMarkdownController;
		onSubmitKeydown: (event: KeyboardEvent) => void;
		onCompletionKeydown: (event: KeyboardEvent) => boolean;
	} = $props();
</script>

{#await loadComposerMarkdownEditor()}
	<pre
		class="max-h-[min(40dvh,150px)] overflow-auto whitespace-pre-wrap px-4 py-3 text-base text-composer-foreground sm:max-h-[min(40dvh,300px)] sm:px-5">{draft.source}</pre>
{:then MarkdownEditor}
	<MarkdownEditor
		document={draft.document}
		sources={draft.sources}
		selection={draft.selection}
		selectionMarks={draft.selectionMarks}
		{readOnly}
		snippetTrigger={controller.snippetTrigger}
		{onSubmitKeydown}
		{onCompletionKeydown}
		onChange={(text) => controller.change(text)}
		onPlain={(text, caret) => controller.plain(text, caret)}
		onSnippet={(text, caret) => controller.snippet(text, caret)}
		onEditSource={() => void controller.edit()}
		onReady={(target) => controller.focus(target)}
		onMention={(mention) => controller.mention(mention)}
		onLargePaste={(request) => void controller.pasteSource(request)}
	/>
{:catch}
	<button
		type="button"
		onclick={() => void controller.edit()}
		class="px-4 py-3 text-sm text-muted-foreground">{m.chat_composer_format_unavailable()}</button
	>
{/await}
