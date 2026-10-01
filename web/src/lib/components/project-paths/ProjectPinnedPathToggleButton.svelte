<script lang="ts">
	import Pin from '@lucide/svelte/icons/pin';
	import PinOff from '@lucide/svelte/icons/pin-off';
	import Loader2 from '@lucide/svelte/icons/loader-2';
	import { cn } from '$lib/utils/cn.js';
	import * as m from '$lib/paraglide/messages.js';

	interface ProjectPinnedPathToggleButtonProps {
		isPinned: boolean;
		disabled?: boolean;
		loading?: boolean;
		onToggle: () => void | Promise<void>;
		class?: string;
		iconClass?: string;
	}

	let {
		isPinned,
		disabled = false,
		loading = false,
		onToggle,
		class: className,
		iconClass,
	}: ProjectPinnedPathToggleButtonProps = $props();

	const label = $derived(
		isPinned ? m.chat_new_chat_remove_from_favorites() : m.chat_new_chat_add_to_favorites(),
	);
	const resolvedIconClass = $derived(
		iconClass ?? (isPinned ? 'h-4 w-4 text-primary' : 'h-4 w-4 text-muted-foreground'),
	);
	const isDisabled = $derived(disabled || loading);

	function handleClick(): void {
		if (isDisabled) return;
		void onToggle();
	}
</script>

<button
	type="button"
	disabled={isDisabled}
	onclick={handleClick}
	class={cn(
		'inline-flex items-center justify-center transition-colors disabled:cursor-not-allowed disabled:opacity-40',
		className,
	)}
	title={label}
	aria-label={label}
	aria-busy={loading}
>
	{#if loading}
		<Loader2 class="h-4 w-4 animate-spin text-muted-foreground" aria-hidden="true" />
	{:else if isPinned}
		<PinOff class={resolvedIconClass} aria-hidden="true" />
	{:else}
		<Pin class={resolvedIconClass} aria-hidden="true" />
	{/if}
</button>
