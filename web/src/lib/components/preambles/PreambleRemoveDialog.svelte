<script lang="ts">
	import * as Dialog from '$lib/components/ui/dialog';
	import { Button } from '$lib/components/ui/button';
	import type { Preamble } from '$shared/preambles';
	import * as m from '$lib/paraglide/messages.js';

	interface Props {
		open: boolean;
		preamble: Preamble | null;
		removing?: boolean;
		error?: string | null;
		onConfirm: () => void;
		onClose: () => void;
	}

	let {
		open,
		preamble,
		removing = false,
		error = null,
		onConfirm,
		onClose,
	}: Props = $props();
</script>

<Dialog.Root {open} requestClose={() => !removing && onClose()}>
	<Dialog.Content class="sm:max-w-md">
		<Dialog.Header>
			<Dialog.Title>{m.preambles_remove_title()}</Dialog.Title>
			<Dialog.Description>
				{m.preambles_remove_confirmation({ title: preamble?.title ?? '' })}
			</Dialog.Description>
		</Dialog.Header>
		{#if error}
			<p role="alert" class="text-sm text-destructive">{error}</p>
		{/if}
		<Dialog.Footer>
			<Button variant="secondary" onclick={onClose} disabled={removing}>
				{m.preambles_cancel()}
			</Button>
			<Button variant="destructive" onclick={onConfirm} disabled={removing || !preamble}>
				{removing ? m.preambles_removing() : m.preambles_remove()}
			</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
