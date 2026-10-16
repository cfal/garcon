<script lang="ts">
	import Code from '@lucide/svelte/icons/code';
	import Pilcrow from '@lucide/svelte/icons/pilcrow';
	import LoaderCircle from '@lucide/svelte/icons/loader-circle';
	import * as m from '$lib/paraglide/messages.js';
	import type { ComposerInputMode } from '$lib/chat/composer/markdown-input.js';

	let { mode, pending, disabled, onSelect }: {
		mode: ComposerInputMode;
		pending: boolean;
		disabled: boolean;
		onSelect: (mode: ComposerInputMode) => void;
	} = $props();
</script>

<div class="flex items-center gap-1 px-3 pt-2" role="group" aria-label={m.chat_composer_input_mode()} aria-busy={pending}>
	{#each ['source', 'formatted'] as value}
		{@const formatted = value === 'formatted'}
		<button
			type="button"
			{disabled}
			aria-pressed={mode === value}
			title={formatted ? m.chat_composer_formatted_mode() : m.chat_composer_source_mode()}
			onclick={() => onSelect(formatted ? 'formatted' : 'source')}
			class="flex h-9 items-center gap-1.5 rounded-md px-2 text-xs text-muted-foreground hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50 aria-pressed:bg-accent aria-pressed:text-accent-foreground"
		>
			{#if formatted}<Pilcrow class="size-3.5" aria-hidden="true" />{:else}<Code class="size-3.5" aria-hidden="true" />{/if}
			{formatted ? m.chat_composer_formatted_mode() : m.chat_composer_source_mode()}
		</button>
	{/each}
	{#if pending}<LoaderCircle class="size-4 animate-spin text-muted-foreground" aria-label={m.chat_composer_format_pending()} />{/if}
</div>
