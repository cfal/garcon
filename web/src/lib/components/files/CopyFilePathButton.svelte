<script lang="ts">
	import Check from '@lucide/svelte/icons/check';
	import Copy from '@lucide/svelte/icons/copy';
	import { onDestroy } from 'svelte';
	import * as m from '$lib/paraglide/messages.js';
	import { copyToClipboard } from '$lib/utils/clipboard';

	interface CopyFilePathButtonProps {
		path: string;
		class?: string;
		container?: Element;
	}

	let { path, class: className = '', container }: CopyFilePathButtonProps = $props();
	let copied = $state(false);
	let resetTimer: ReturnType<typeof setTimeout> | null = null;

	async function handleCopy(event: MouseEvent): Promise<void> {
		event.stopPropagation();
		if (!(await copyToClipboard(path, container))) return;
		copied = true;
		if (resetTimer) clearTimeout(resetTimer);
		resetTimer = setTimeout(() => {
			copied = false;
			resetTimer = null;
		}, 2000);
	}

	onDestroy(() => {
		if (resetTimer) clearTimeout(resetTimer);
	});
</script>

<button
	type="button"
	class="inline-flex size-6 shrink-0 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring {copied
		? 'text-status-success-foreground'
		: ''} {className}"
	onclick={handleCopy}
	title={copied ? m.file_path_copied_short() : m.file_path_copy()}
	aria-label={copied ? m.file_path_copied() : m.file_path_copy()}
	data-copy-file-path
>
	{#if copied}
		<Check class="size-3.5" aria-hidden="true" />
	{:else}
		<Copy class="size-3.5" aria-hidden="true" />
	{/if}
</button>
