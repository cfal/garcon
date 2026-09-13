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

<div class="issue-detail-header">
	<button
		type="button"
		class="issue-button issue-back"
		onclick={onBack}
		data-issue-focus={JSON.stringify({ kind: 'toolbar', control: 'back' })}
	>
		<ArrowLeft size={15} />{m.issues_back()}
	</button>
	{#if onClose}<button
			type="button"
			class="issue-button issue-icon-button issue-detail-close"
			onclick={onClose}
			disabled={closeDisabled}
			aria-label={m.issues_close_view()}
			title={m.issues_close_view()}><X size={16} /></button
		>{/if}
</div>
