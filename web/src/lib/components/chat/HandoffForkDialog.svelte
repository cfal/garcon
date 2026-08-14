<script lang="ts">
	import * as Dialog from '$lib/components/ui/dialog';
	import { Button } from '$lib/components/ui/button';
	import * as m from '$lib/paraglide/messages.js';

	let {
		open,
		onCancel,
		onConfirm,
	}: {
		open: boolean;
		onCancel: () => void;
		onConfirm: () => void;
	} = $props();

	function handleOpenChange(next: boolean): void {
		if (!next) onCancel();
	}
</script>

<Dialog.Root {open} onOpenChange={handleOpenChange}>
	<Dialog.Content class="sm:max-w-lg">
		<Dialog.Header>
			<Dialog.Title>{m.chat_handoff_fork_title()}</Dialog.Title>
			<Dialog.Description>
				{m.chat_handoff_fork_description()}
			</Dialog.Description>
		</Dialog.Header>
		<Dialog.Footer>
			<Button variant="outline" onclick={onCancel}>
				{m.sidebar_actions_cancel()}
			</Button>
			<Button onclick={onConfirm}>
				{m.chat_handoff_fork_confirm()}
			</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
