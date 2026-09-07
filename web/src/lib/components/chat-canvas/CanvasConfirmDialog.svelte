<script lang="ts">
	import * as Dialog from '$lib/components/ui/dialog';
	import * as m from '$lib/paraglide/messages.js';
	let {
		title,
		description,
		errorMessage,
		onconfirm,
		onclose,
	}: {
		title: string;
		description: string;
		errorMessage?: string | null;
		onconfirm: () => Promise<boolean>;
		onclose: () => void;
	} = $props();
	let busy = $state(false);
	async function confirm() {
		if (busy) return;
		busy = true;
		try {
			if (await onconfirm()) onclose();
		} finally {
			busy = false;
		}
	}
</script>

<Dialog.Root
	open
	onOpenChange={(open) => {
		if (!open && !busy) onclose();
	}}
>
	<Dialog.Content>
		<Dialog.Header
			><Dialog.Title>{title}</Dialog.Title><Dialog.Description>{description}</Dialog.Description
			></Dialog.Header
		>
		{#if errorMessage}<p role="alert" class="text-sm text-destructive">{errorMessage}</p>{/if}
		<div class="flex justify-end gap-2">
			<button class="canvas-button" disabled={busy} onclick={onclose}>{m.canvas_cancel()}</button
			><button class="canvas-button" disabled={busy} onclick={() => void confirm()}>{title}</button>
		</div>
	</Dialog.Content>
</Dialog.Root>
