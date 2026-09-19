<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import Plus from '@lucide/svelte/icons/plus';
	import Pencil from '@lucide/svelte/icons/pencil';
	import Copy from '@lucide/svelte/icons/copy';
	import Eye from '@lucide/svelte/icons/eye';
	import EyeOff from '@lucide/svelte/icons/eye-off';
	import Trash2 from '@lucide/svelte/icons/trash-2';
	import ArrowLeft from '@lucide/svelte/icons/arrow-left';
	import * as Dialog from '$lib/components/ui/dialog';
	import { Button } from '$lib/components/ui/button';
	import { getAppShell, getExecutionNodes } from '$lib/context';
	import { executionNodeStatus } from '$lib/execution-nodes/execution-nodes-store.svelte.js';
	import { copyToClipboard } from '$lib/utils/clipboard';
	import { ExecutionNodeEditor } from './execution-node-editor.svelte.js';

	const shell = getAppShell();
	const nodes = getExecutionNodes();
	const editor = new ExecutionNodeEditor(nodes);
	let editing = $state(false);
	let copied = $state(false);
	let content = $state<HTMLElement | null>(null);
	const inputClass = 'h-10 w-full min-w-0 rounded-md border border-input bg-background px-3';

	onMount(() => { void nodes.refresh(); });
	onDestroy(() => editor.clear());

	function back(): void { editor.clear(); editing = false; copied = false; }
	function close(): void { back(); shell.closeExecutionNodes(); }
	async function copy(): Promise<void> {
		const url = editor.connectionUrl;
		copied = await copyToClipboard(url, content ?? undefined, () => editor.connectionUrl === url);
		if (!copied) editor.error = 'Unable to copy connection URL';
	}
</script>

<Dialog.Root open={shell.showExecutionNodes} onOpenChange={(open) => { if (!open) close(); }}>
	<Dialog.Content bind:ref={content} class="safe-viewport-dialog max-h-[calc(var(--app-height)-2rem)] overflow-y-auto sm:max-w-2xl">
		<Dialog.Header>
			<Dialog.Title>Execution Nodes</Dialog.Title>
			<Dialog.Description class="sr-only">Execution node configuration</Dialog.Description>
		</Dialog.Header>
		{#if !editing}
			<div class="flex justify-end"><Button onclick={() => { editor.clear(); editing = true; }}><Plus class="size-4" />Add Node</Button></div>
			{#if nodes.error}<p role="alert" class="text-sm text-destructive">{nodes.error}</p>{/if}
			{#if nodes.loading && nodes.nodes.length === 0}<p role="status">Loading...</p>{/if}
			<ul class="divide-y divide-border border-y border-border">
				{#each nodes.nodes as node (node.id)}
					<svelte:boundary>
						<li class="flex min-w-0 items-center gap-3 py-3">
							<div class="min-w-0 flex-1">
								<div class="break-words text-sm font-medium">{node.label}</div>
								<p class="text-xs text-muted-foreground">{node.kind === 'local' ? 'Local' : node.direction === 'node-connects' ? 'Node connects to controller' : 'Controller connects to node'} / {executionNodeStatus(node)}</p>
								{#if node.lastError}<p class="mt-1 break-words text-xs text-destructive">{node.lastError.message}</p>{/if}
							</div>
							{#if node.kind === 'remote'}
								<Button variant="ghost" size="icon-sm" aria-label={`Edit ${node.label}`} title={`Edit ${node.label}`} onclick={() => { editing = true; void editor.edit(node); }}><Pencil class="size-4" /></Button>
							{/if}
						</li>
						{#snippet failed()}<li class="py-3 text-sm text-destructive">Unable to display node</li>{/snippet}
					</svelte:boundary>
				{/each}
			</ul>
		{:else}
			<form class="space-y-4" onsubmit={(event) => { event.preventDefault(); void editor.save(); }}>
				<div class="flex items-center gap-2"><Button type="button" variant="ghost" size="icon-sm" onclick={back} aria-label="Back to nodes" title="Back to nodes"><ArrowLeft class="size-4" /></Button><h3 class="text-sm font-medium">{editor.id ? 'Edit Node' : 'Add Node'}</h3></div>
				<label class="block space-y-1 text-sm">Label<input id="execution-node-label" class={`${inputClass} text-base pointer-fine:text-sm`} bind:value={editor.label} required maxlength="100" disabled={editor.busy} /></label>
				<label class="block space-y-1 text-sm">Connection direction
					<select id="execution-node-direction" class={`${inputClass} text-base pointer-fine:text-sm`} bind:value={editor.direction} disabled={editor.busy}>
						<option value="node-connects">Node connects to controller</option>
						<option value="controller-connects">Controller connects to node</option>
					</select>
				</label>
				{#if editor.id || editor.direction === 'controller-connects'}
					<label class="block space-y-1 text-sm">Connection URL
						<input id="execution-node-url" class={`${inputClass} text-base pointer-fine:text-sm`} type={editor.revealed ? 'text' : 'password'} bind:value={editor.connectionUrl} required autocomplete="off" spellcheck={false} disabled={editor.busy} />
					</label>
					<div class="flex items-center gap-2">
						<Button type="button" variant="outline" size="icon-sm" title={editor.revealed ? 'Hide URL' : 'Reveal URL'} aria-label={editor.revealed ? 'Hide URL' : 'Reveal URL'} onclick={() => editor.revealed = !editor.revealed}>{#if editor.revealed}<EyeOff class="size-4" />{:else}<Eye class="size-4" />{/if}</Button>
						<Button type="button" variant="outline" size="icon-sm" title="Copy connection URL" aria-label="Copy connection URL" disabled={!editor.connectionUrl} onclick={copy}><Copy class="size-4" /></Button>
						{#if copied}<span role="status" class="text-xs text-muted-foreground">Copied</span>{/if}
					</div>
					<p class="text-xs text-muted-foreground">This URL contains a secret. Shell history and startup logs may retain it.</p>
				{/if}
				<label class="flex items-center gap-2 text-sm"><input id="execution-node-insecure" type="checkbox" bind:checked={editor.allowInsecureDevelopment} disabled={editor.busy} />Allow unencrypted development connection (ws://)</label>
				{#if editor.id}<label class="flex items-center gap-2 text-sm"><input type="checkbox" bind:checked={editor.enabled} disabled={editor.busy} />Enabled</label>{/if}
				{#if editor.error}<p role="alert" class="break-words text-sm text-destructive">{editor.error}</p>{/if}
				<div class="flex items-center justify-between gap-2 border-t border-border pt-4">
					{#if editor.id}
						{#if editor.confirmDelete}
							<div class="flex flex-wrap gap-2"><Button type="button" variant="destructive" disabled={editor.busy} onclick={async () => { if (await editor.remove()) back(); }}>Delete Node</Button><Button type="button" variant="ghost" onclick={() => editor.confirmDelete = false}>Cancel</Button></div>
						{:else}<Button type="button" variant="ghost" size="icon-sm" aria-label="Delete node" title="Delete node" disabled={editor.busy} onclick={() => editor.confirmDelete = true}><Trash2 class="size-4" /></Button>{/if}
					{:else}<span></span>{/if}
					<Button type="submit" disabled={editor.busy || !editor.label.trim()}>{editor.busy ? 'Saving...' : editor.id ? 'Save' : 'Add Node'}</Button>
				</div>
			</form>
		{/if}
	</Dialog.Content>
</Dialog.Root>
