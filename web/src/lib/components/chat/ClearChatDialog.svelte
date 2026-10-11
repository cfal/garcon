<script lang="ts">
	import * as Dialog from '$lib/components/ui/dialog';
	import { Button } from '$lib/components/ui/button';
	import * as m from '$lib/paraglide/messages.js';

	let { open, busy, error, onCancel, onConfirm }: {
		open: boolean;
		busy: boolean;
		error: string | null;
		onCancel: () => void;
		onConfirm: () => void;
	} = $props();
</script>

<Dialog.Root {open} onOpenChange={(next) => { if (!next) onCancel(); }}>
	<Dialog.Content class="sm:max-w-lg">
		<Dialog.Header>
			<Dialog.Title>{m.chat_clear_title()}</Dialog.Title>
			<Dialog.Description>{m.chat_clear_description()}</Dialog.Description>
		</Dialog.Header>
		{#if error}
			<p role="alert" class="text-sm text-destructive">{error}</p>
		{/if}
		<Dialog.Footer>
			<Button variant="outline" disabled={busy} onclick={onCancel}>{m.sidebar_actions_cancel()}</Button>
			<Button variant="destructive" disabled={busy} onclick={onConfirm}>
				{busy ? m.chat_clear_pending() : m.chat_clear_confirm()}
			</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
