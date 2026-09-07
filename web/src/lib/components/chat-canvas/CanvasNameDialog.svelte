<script lang="ts">
	import { untrack } from 'svelte';
	import * as Dialog from '$lib/components/ui/dialog';
	import * as m from '$lib/paraglide/messages.js';
	let {
		title,
		initial = '',
		maxLength = 120,
		errorMessage,
		onsubmit,
		onclose,
	}: {
		title: string;
		initial?: string;
		maxLength?: number;
		errorMessage?: string | null;
		onsubmit: (value: string) => Promise<boolean> | boolean;
		onclose: () => void;
	} = $props();
	let value = $state(untrack(() => initial));
	let busy = $state(false);
	let error = $state<string | null>(null);
	async function submit(event: SubmitEvent) {
		event.preventDefault();
		if (busy || !value.trim()) return;
		busy = true;
		try {
			if (await onsubmit(value.trim())) onclose();
		} catch (cause) {
			error = cause instanceof Error ? cause.message : String(cause);
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
			><Dialog.Title>{title}</Dialog.Title><Dialog.Description
				>{m.canvas_title_required()}</Dialog.Description
			></Dialog.Header
		>
		<form onsubmit={submit} class="space-y-4">
			<input
				class="canvas-input text-base"
				aria-label={title}
				bind:value
				maxlength={maxLength}
				disabled={busy}
			/>
			{#if error || errorMessage}<p role="alert" class="text-sm text-destructive">
					{error || errorMessage}
				</p>{/if}
			<div class="flex justify-end gap-2">
				<button class="canvas-button" type="button" disabled={busy} onclick={onclose}
					>{m.canvas_cancel()}</button
				><button class="canvas-button" disabled={busy || !value.trim()}>{m.canvas_apply()}</button>
			</div>
		</form>
	</Dialog.Content>
</Dialog.Root>
