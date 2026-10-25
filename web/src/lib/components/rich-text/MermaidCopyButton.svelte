<script lang="ts">
	import Check from '@lucide/svelte/icons/check';
	import Copy from '@lucide/svelte/icons/copy';
	import { onDestroy } from 'svelte';
	import { Button } from '$lib/components/ui/button';
	import * as m from '$lib/paraglide/messages.js';
	import { copyToClipboard } from '$lib/utils/clipboard';

	let { source }: { source: string } = $props();
	let copied = $state(false);
	let resetTimer: ReturnType<typeof setTimeout> | null = null;
	let destroyed = false;
	const copyLabel = $derived(copied ? m.chat_code_block_copied() : m.chat_mermaid_copy());

	async function handleCopy(event: MouseEvent): Promise<void> {
		const button = event.currentTarget as HTMLButtonElement;
		const container = button.closest('[role="dialog"]') ?? undefined;
		const currentSource = source;
		const isCurrent = () => !destroyed && source === currentSource;
		const didCopy = await copyToClipboard(currentSource, container, isCurrent);
		if (!didCopy || !isCurrent()) return;
		copied = true;
		if (resetTimer) clearTimeout(resetTimer);
		resetTimer = setTimeout(() => {
			copied = false;
			resetTimer = null;
		}, 2000);
	}

	onDestroy(() => {
		destroyed = true;
		if (resetTimer) clearTimeout(resetTimer);
	});
</script>

<Button
	variant="ghost"
	size="icon-sm"
	onclick={handleCopy}
	title={copyLabel}
	aria-label={copyLabel}
>
	{#if copied}
		<Check class="text-status-success-foreground" />
	{:else}
		<Copy />
	{/if}
</Button>
