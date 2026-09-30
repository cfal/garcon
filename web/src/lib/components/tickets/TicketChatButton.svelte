<script lang="ts">
	import MessageSquarePlus from '@lucide/svelte/icons/message-square-plus';
	import LoaderCircle from '@lucide/svelte/icons/loader-circle';
	let {
		label,
		pending = false,
		disabled = false,
		onOpen,
	}: {
		label: string;
		pending?: boolean;
		disabled?: boolean;
		onOpen: () => void;
	} = $props();
</script>

<button
	type="button"
	class="ticket-button"
	disabled={disabled || pending}
	aria-busy={pending}
	onclick={onOpen}
>
	{#if pending}<LoaderCircle size={15} class="animate-spin" aria-hidden="true" />
	{:else}<MessageSquarePlus size={15} aria-hidden="true" />{/if}
	{label}
</button>
