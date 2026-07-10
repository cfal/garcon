<script lang="ts">
	import * as Dialog from '$lib/components/ui/dialog';
	import { Button } from '$lib/components/ui/button';
	import * as m from '$lib/paraglide/messages.js';

	interface Props {
		open: boolean;
		entries: string[];
		onClose: () => void;
	}

	let { open, entries, onClose }: Props = $props();
</script>

<Dialog.Root {open} onOpenChange={(value) => !value && onClose()}>
	<Dialog.Content class="max-h-[80vh] sm:max-w-2xl">
		<Dialog.Header>
			<Dialog.Title>{m.scheduled_tasks_run_log()}</Dialog.Title>
			<Dialog.Description>{m.scheduled_tasks_run_log_description()}</Dialog.Description>
		</Dialog.Header>
		<div class="min-h-32 overflow-y-auto rounded-md border border-border bg-muted/20 p-3">
			{#if entries.length === 0}
				<p class="py-8 text-center text-sm text-muted-foreground">
					{m.scheduled_tasks_run_log_empty()}
				</p>
			{:else}
				<ol class="space-y-2 font-mono text-xs text-foreground">
					{#each entries as entry, index (`${index}:${entry}`)}
						<li class="break-words border-b border-border/60 pb-2 last:border-0 last:pb-0">
							{entry}
						</li>
					{/each}
				</ol>
			{/if}
		</div>
		<Dialog.Footer>
			<Button variant="secondary" onclick={onClose}>{m.editor_actions_close()}</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
