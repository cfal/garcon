<script lang="ts">
	import Check from '@lucide/svelte/icons/check';
	import Copy from '@lucide/svelte/icons/copy';
	import { copyToClipboard } from '$lib/utils/clipboard.js';
	import * as m from '$lib/paraglide/messages.js';

	interface GitCommentAppendErrorProps {
		error: string;
		copyText: string | null;
	}

	let { error, copyText }: GitCommentAppendErrorProps = $props();
	let container = $state<HTMLDivElement | null>(null);
	let copyStatus = $state<'idle' | 'copied' | 'failed'>('idle');

	async function copyComment(): Promise<void> {
		if (!copyText) return;
		copyStatus = (await copyToClipboard(copyText, container ?? undefined)) ? 'copied' : 'failed';
	}
</script>

<div bind:this={container} class="flex items-center gap-2 px-3 pb-2 text-xs text-status-error-foreground" role="alert">
	<span class="min-w-0 flex-1">{error}</span>
	{#if copyText}
		<button type="button" class="inline-flex shrink-0 items-center gap-1 rounded border border-border px-2 py-1 font-medium text-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-interactive-accent" onclick={copyComment}>
			{#if copyStatus === 'copied'}<Check class="h-3 w-3" /> {m.git_comment_copied()}{:else}<Copy class="h-3 w-3" /> {m.git_comment_copy()}{/if}
		</button>
		{#if copyStatus === 'failed'}<span>{m.git_comment_copy_failed()}</span>{/if}
	{/if}
</div>
