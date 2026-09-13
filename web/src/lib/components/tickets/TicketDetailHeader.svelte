<script lang="ts">
	import ArrowLeft from '@lucide/svelte/icons/arrow-left';
	import X from '@lucide/svelte/icons/x';
	import * as m from '$lib/paraglide/messages.js';
	let {
		onBack,
		onClose,
		closeDisabled = false,
	}: {
		onBack: () => void;
		onClose?: () => void;
		closeDisabled?: boolean;
	} = $props();
</script>

<div class="ticket-detail-header">
	<button
		type="button"
		class="ticket-button ticket-back"
		onclick={onBack}
		data-ticket-focus={JSON.stringify({ kind: 'toolbar', control: 'back' })}
	>
		<ArrowLeft size={15} />{m.tickets_back()}
	</button>
	{#if onClose}<button
			type="button"
			class="ticket-button ticket-icon-button ticket-detail-close"
			onclick={onClose}
			disabled={closeDisabled}
			aria-label={m.tickets_close_view()}
			title={m.tickets_close_view()}><X size={16} /></button
		>{/if}
</div>
