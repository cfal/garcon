<script lang="ts">
	import * as Dialog from '$lib/components/ui/dialog';
	import { Button } from '$lib/components/ui/button';
	import type { ScheduledPrompt } from '$shared/scheduled-prompts';
	import * as m from '$lib/paraglide/messages.js';

	interface Props {
		open: boolean;
		scheduledPrompt: ScheduledPrompt | null;
		removing?: boolean;
		error?: string | null;
		onConfirm: () => void;
		onClose: () => void;
	}

	let {
		open,
		scheduledPrompt,
		removing = false,
		error = null,
		onConfirm,
		onClose,
	}: Props = $props();
	let title = $derived(scheduledPrompt?.prompt.split(/\r?\n/, 1)[0]?.trim() ?? '');
</script>

<Dialog.Root {open} onOpenChange={(value) => !value && !removing && onClose()}>
	<Dialog.Content class="sm:max-w-md">
		<Dialog.Header>
			<Dialog.Title>{m.scheduled_prompts_remove_title()}</Dialog.Title>
			<Dialog.Description>
				{m.scheduled_prompts_remove_confirmation({ title })}
			</Dialog.Description>
		</Dialog.Header>
		{#if error}
			<p role="alert" class="text-sm text-destructive">{error}</p>
		{/if}
		<Dialog.Footer>
			<Button variant="secondary" onclick={onClose} disabled={removing}>
				{m.scheduled_prompts_cancel()}
			</Button>
			<Button variant="destructive" onclick={onConfirm} disabled={removing || !scheduledPrompt}>
				{removing ? m.scheduled_prompts_removing() : m.scheduled_prompts_remove()}
			</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
