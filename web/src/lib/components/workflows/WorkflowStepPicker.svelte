<script lang="ts">
	import Bot from '@lucide/svelte/icons/bot';
	import Terminal from '@lucide/svelte/icons/terminal';
	import UserCheck from '@lucide/svelte/icons/user-check';
	import * as Dialog from '$lib/components/ui/dialog';
	import { Button } from '$lib/components/ui/button';
	import type { WorkflowStep } from '$shared/workflow-definition';
	import * as m from '$lib/paraglide/messages.js';
	import { workflowStepKindLabel } from './workflow-labels';

	let {
		insert,
		onClose,
		onPick,
	}: {
		insert: boolean;
		onClose: () => void;
		onPick: (kind: WorkflowStep['kind']) => void;
	} = $props();
	let search = $state('');
	const choices = [
		{ kind: 'agent', Icon: Bot },
		{ kind: 'command', Icon: Terminal },
		{ kind: 'decision', Icon: UserCheck },
	] as const;
	const matching = $derived(
		choices.filter(({ kind }) =>
			workflowStepKindLabel(kind).toLowerCase().includes(search.trim().toLowerCase()),
		),
	);
</script>

<Dialog.Root
	open
	onOpenChange={(open) => {
		if (!open) onClose();
	}}
>
	<Dialog.Content>
		<Dialog.Header
			><Dialog.Title
				>{insert ? m.workflow_studio_insert_step() : m.workflow_studio_add_step()}</Dialog.Title
			></Dialog.Header
		>
		<input
			type="search"
			class="workflow-field"
			aria-label={m.workflow_studio_find_step_type()}
			placeholder={m.workflow_studio_find_step_type()}
			bind:value={search}
		/>
		<div class="grid gap-2">
			{#each matching as { kind, Icon } (kind)}
				<Button variant="outline" class="justify-start" onclick={() => onPick(kind)}
					><Icon class="size-4" /> {workflowStepKindLabel(kind)}</Button
				>
			{:else}
				<p class="text-sm text-muted-foreground">{m.workflow_studio_no_step_types()}</p>
			{/each}
		</div>
	</Dialog.Content>
</Dialog.Root>
