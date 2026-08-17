<script lang="ts">
	import ChatEventCard from '../rows/ChatEventCard.svelte';
	import HighlightedCodeText from '../HighlightedCodeText.svelte';

	interface Props {
		command: string;
		anchorId?: string;
	}

	let { command, anchorId }: Props = $props();
</script>

<div class="group my-0.5">
	<ChatEventCard variant="bash" compact>
		{#snippet body()}
			<code
				id={anchorId}
				class="code-highlight scroll-mt-16 block whitespace-pre-wrap break-all font-mono text-xs leading-[1.25] text-foreground"
				data-chat-bash-command
				><span class="inline-block w-5 text-center text-muted-foreground">{'$ '}</span
				><HighlightedCodeText text={command} language="bash" /></code
			>
		{/snippet}
	</ChatEventCard>
</div>
