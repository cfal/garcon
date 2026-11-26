<script lang="ts">
	import { onDestroy } from 'svelte';
	import Check from '@lucide/svelte/icons/check';
	import Copy from '@lucide/svelte/icons/copy';
	import * as m from '$lib/paraglide/messages.js';
	import { ChatClipboardFeedback } from './chat-clipboard-feedback.svelte.js';

	interface Props {
		label: string;
		value: string | null;
		surfaceClass: string;
	}

	let { label, value, surfaceClass }: Props = $props();
	const clipboard = new ChatClipboardFeedback();
	onDestroy(() => clipboard.reset());

	function copyValue(event: MouseEvent): Promise<void> {
		const container = (event.currentTarget as HTMLElement).closest('[role="dialog"]') ?? undefined;
		return clipboard.copy(value, container);
	}
</script>

<div class="min-w-0 space-y-1">
	<div class="flex items-center justify-between gap-2">
		<div class="text-sm font-medium">{label}</div>
		<button
			type="button"
			class="inline-flex items-center justify-center text-muted-foreground transition-colors hover:text-foreground"
			onclick={copyValue}
			title={m.chat_tool_display_copy_to_clipboard()}
			aria-label={m.chat_tool_display_copy_to_clipboard()}
		>
			{#if clipboard.copied}
				<Check class="size-4 text-status-success-foreground" />
			{:else}
				<Copy class="size-4" />
			{/if}
		</button>
	</div>
	<!-- Uses a selectable pre surface instead of a textarea so iOS does not zoom on focus. -->
	<pre
		role="region"
		aria-label={label}
		class="w-full max-w-full min-w-0 select-text overflow-y-auto whitespace-pre-wrap break-words rounded-md border border-input bg-background p-2 font-mono text-xs leading-snug text-foreground {surfaceClass}">{value ??
			''}</pre>
</div>
