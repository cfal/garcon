<script lang="ts">
	import * as Dialog from '$lib/components/ui/dialog';
	import { Button } from '$lib/components/ui/button';
	import { getExecutionNodes } from '$lib/context';
	import type { NodeHandoffProjectState } from '$lib/chat/conversation/node-handoff-project.svelte.js';
	let { handoff }: { handoff: NodeHandoffProjectState } = $props();
	const nodes = getExecutionNodes();
</script>

<Dialog.Root open={handoff.target !== null} onOpenChange={(open) => { if (!open) handoff.cancel(); }}>
	<Dialog.Content class="sm:max-w-lg">
		<Dialog.Header><Dialog.Title>Move to {nodes.label(handoff.target?.nodeId)}</Dialog.Title><Dialog.Description>A new agent session will use this conversation. Project files stay on their original node.</Dialog.Description></Dialog.Header>
		<form class="space-y-4" onsubmit={(event) => { event.preventDefault(); void handoff.confirm(); }}>
			<label class="block space-y-1 text-sm">Destination project folder<input class="h-10 w-full rounded-md border border-input bg-background px-3 text-base pointer-fine:text-sm" bind:value={handoff.projectPath} required disabled={handoff.checking} /></label>
			{#if handoff.error}<p role="alert" class="text-sm text-destructive">{handoff.error}</p>{/if}
			<Dialog.Footer><Button type="button" variant="outline" onclick={() => handoff.cancel()}>Cancel</Button><Button type="submit" disabled={handoff.checking || !handoff.projectPath.trim()}>{handoff.checking ? 'Checking...' : 'Use This Node'}</Button></Dialog.Footer>
		</form>
	</Dialog.Content>
</Dialog.Root>
