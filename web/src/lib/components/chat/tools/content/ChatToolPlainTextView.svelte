<script lang="ts">
	// Renders plain text, JSON, or code content for tool output.

	interface TextContentProps {
		content: string;
		format?: 'plain' | 'json' | 'code';
		class?: string;
	}

	let { content, format = 'plain', class: className = '' }: TextContentProps = $props();

	let formattedContent = $derived.by(() => {
		if (format !== 'json') return content;
		try {
			return JSON.stringify(JSON.parse(content), null, 2);
		} catch {
			return content;
		}
	});
</script>

{#if format === 'json'}
	<pre
		class="mt-1 text-xs bg-muted border border-border text-foreground p-2.5 rounded overflow-x-auto font-mono {className}"
		>{formattedContent}</pre
	>
{:else if format === 'code'}
	<pre
		class="mt-1 text-xs bg-muted/40 border border-border p-2 rounded whitespace-pre-wrap break-words overflow-hidden text-foreground/85 font-mono {className}"
		>{content}</pre
	>
{:else}
	<div class="mt-1 text-sm text-foreground/85 whitespace-pre-wrap {className}">
		{content}
	</div>
{/if}
