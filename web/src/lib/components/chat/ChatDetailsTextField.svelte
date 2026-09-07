<script lang="ts">
	import { onDestroy } from 'svelte';
	import Check from '@lucide/svelte/icons/check';
	import Copy from '@lucide/svelte/icons/copy';
	import * as m from '$lib/paraglide/messages.js';
	import { copyToClipboard } from '$lib/utils/clipboard';

	interface Props {
		label: string;
		value: string | null;
		surfaceClass: string;
	}

	let { label, value, surfaceClass }: Props = $props();
	let copied = $state(false);
	let copiedResetTimer: ReturnType<typeof setTimeout> | null = null;

	async function copyValue(event: MouseEvent): Promise<void> {
		if (!value) return;
		const container = (event.currentTarget as HTMLElement).closest('[role="dialog"]') ?? undefined;
		if (!(await copyToClipboard(value, container))) return;

		copied = true;
		if (copiedResetTimer) clearTimeout(copiedResetTimer);
		copiedResetTimer = setTimeout(() => {
			copied = false;
			copiedResetTimer = null;
		}, 2000);
	}

	onDestroy(() => {
		if (copiedResetTimer) clearTimeout(copiedResetTimer);
	});
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
			{#if copied}
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
