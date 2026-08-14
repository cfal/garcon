<script lang="ts">
	import HighlightedCodeText from '../HighlightedCodeText.svelte';

	interface Props {
		command: string;
		anchorId?: string;
	}

	let { command, anchorId }: Props = $props();
</script>

<code
	id={anchorId}
	class="code-highlight scroll-mt-16 block whitespace-pre-wrap break-all font-mono text-xs text-foreground"
	data-chat-bash-command
	><span class="text-muted-foreground">{'$ '}</span><HighlightedCodeText
		text={command}
		language="bash"
	/></code
>
