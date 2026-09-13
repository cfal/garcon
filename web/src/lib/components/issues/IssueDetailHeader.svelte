<script lang="ts">
	import ArrowLeft from '@lucide/svelte/icons/arrow-left';
	import X from '@lucide/svelte/icons/x';
	import type { Snippet } from 'svelte';
	import * as m from '$lib/paraglide/messages.js';
	let {
		issueId,
		onBack,
		onClose,
		closeDisabled = false,
		children,
	}: {
		issueId: string;
		onBack: () => void;
		onClose?: () => void;
		closeDisabled?: boolean;
		children?: Snippet;
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
	<span class="issue-id">{issueId}</span>
	{@render children?.()}
	{#if onClose}<button
			type="button"
			class="issue-button issue-icon-button issue-detail-close"
			onclick={onClose}
			disabled={closeDisabled}
			aria-label={m.issues_close_view()}
			title={m.issues_close_view()}><X size={16} /></button
		>{/if}
</div>
