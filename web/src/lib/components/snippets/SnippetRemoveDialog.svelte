<script lang="ts">
	import * as Dialog from '$lib/components/ui/dialog';
	import { Button } from '$lib/components/ui/button';
	import * as m from '$lib/paraglide/messages.js';
	import type { Snippet } from '$shared/snippets';

	interface Props {
		open: boolean;
		snippet: Snippet | null;
		removing?: boolean;
		disabled?: boolean;
		error?: string | null;
		onConfirm: () => void;
		onClose: () => void;
	}

	let {
		open,
		snippet,
		removing = false,
		disabled = false,
		error = null,
		onConfirm,
		onClose,
	}: Props = $props();
</script>

<Dialog.Root {open} requestClose={() => !removing && onClose()}>
	<Dialog.Content class="sm:max-w-md">
		<Dialog.Header>
			<Dialog.Title>{m.snippets_remove_title()}</Dialog.Title>
			<Dialog.Description>
				{m.snippets_remove_confirmation({ name: snippet?.shortName ?? '' })}
			</Dialog.Description>
		</Dialog.Header>
		{#if error}
			<p role="alert" class="text-sm text-destructive">{error}</p>
		{/if}
		<Dialog.Footer>
			<Button variant="secondary" onclick={onClose} disabled={removing}>
				{m.snippets_cancel()}
			</Button>
			<Button variant="destructive" onclick={onConfirm} disabled={disabled || removing || !snippet}>
				{removing ? m.snippets_removing() : m.snippets_remove_confirm()}
			</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
