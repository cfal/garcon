<script module lang="ts">
	import { buildUnsupportedHTML } from '@humanspeak/svelte-markdown';
	const renderers = { html: buildUnsupportedHTML() };
	const options = { breaks: true };
</script>

<script lang="ts">
	import SvelteMarkdown from '@humanspeak/svelte-markdown';
	import { composerMarkdownExtensions } from './composer-markdown.js';
	let { source }: { source: string } = $props();
</script>

<div
	class="markdown-body prose prose-sm max-w-none text-foreground prose-headings:text-foreground prose-strong:text-foreground prose-code:text-foreground prose-blockquote:text-muted-foreground"
>
	<SvelteMarkdown {source} {options} {renderers} extensions={composerMarkdownExtensions}>
		{#snippet image({ text })}
			<span class="text-muted-foreground">{text}</span>
		{/snippet}
		{#snippet link({ children })}
			<span class="text-primary underline">{@render children?.()}</span>
		{/snippet}
		{#snippet code({ text })}
			<pre class="overflow-auto rounded-md border border-border bg-muted p-3 text-foreground"><code
					>{text}</code
				></pre>
		{/snippet}
	</SvelteMarkdown>
</div>

<style>
	.markdown-body :global(table) {
		min-width: 32rem;
	}
	.markdown-body :global(th),
	.markdown-body :global(td) {
		vertical-align: top;
		min-width: 10rem;
		overflow-wrap: anywhere;
	}
	.markdown-body :global(> :first-child) {
		margin-top: 0;
	}
	.markdown-body :global(> :last-child) {
		margin-bottom: 0;
	}
</style>
