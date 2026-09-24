<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import Plus from '@lucide/svelte/icons/plus';
	import Pencil from '@lucide/svelte/icons/pencil';
	import Copy from '@lucide/svelte/icons/copy';
	import Trash2 from '@lucide/svelte/icons/trash-2';
	import ArrowLeft from '@lucide/svelte/icons/arrow-left';
	import { Button } from '$lib/components/ui/button';
	import { getExecutionNodes } from '$lib/context';
	import { executionNodeStatus } from '$lib/execution-nodes/execution-nodes-store.svelte.js';
	import { copyToClipboard } from '$lib/utils/clipboard';
	import type { ExecutionNodeSnapshot } from '$shared/execution-nodes';
	import { ExecutionNodeEditor } from './execution-node-editor.svelte.js';

	const nodes = getExecutionNodes();
	const editor = new ExecutionNodeEditor(nodes);
	let editorOpen = $state(false);
	let copied = $state(false);
	let content = $state<HTMLElement | null>(null);
	const inputClass = 'h-10 w-full min-w-0 rounded-md border border-input bg-background px-3';
	const saveButtonLabel = $derived.by(() => {
		if (editor.busy) return 'Saving...';
		if (editor.id) return 'Save';
		return 'Add Node';
	});

	onMount(() => {
		void nodes.refresh();
	});
	onDestroy(() => editor.clear());

	function beginCreate(): void {
		editor.clear();
		editorOpen = true;
	}

	function beginEdit(node: ExecutionNodeSnapshot): void {
		editorOpen = true;
		void editor.edit(node);
	}

	function closeEditor(): void {
		editor.clear();
		editorOpen = false;
		copied = false;
	}

	async function removeNode(): Promise<void> {
		if (await editor.remove()) closeEditor();
	}

	async function copyConnectionUrl(): Promise<void> {
		const url = editor.connectionUrl;
		copied = await copyToClipboard(url, content ?? undefined, () => editor.connectionUrl === url);
		if (!copied) editor.error = 'Unable to copy connection URL';
	}

	function connectionLabel(node: ExecutionNodeSnapshot): string {
		if (node.kind === 'local') return 'Local';
		if (node.direction === 'node-connects') return 'Node connects to controller';
		return 'Controller connects to node';
	}
</script>

<div bind:this={content} class="min-w-0 space-y-4">
	{#if !editorOpen}
		<div class="flex justify-end">
			<Button onclick={beginCreate}><Plus class="size-4" />Add Node</Button>
		</div>
		{#if nodes.error}<p role="alert" class="text-sm text-destructive">{nodes.error}</p>{/if}
		{#if nodes.loading && nodes.nodes.length === 0}<p role="status">Loading...</p>{/if}
		<ul class="divide-y divide-border border-y border-border">
			{#each nodes.nodes as node (node.id)}
				<svelte:boundary>
					<li class="flex min-w-0 items-center gap-3 py-3">
						<div class="min-w-0 flex-1">
							<div class="break-words text-sm font-medium">{node.label}</div>
							<p class="text-xs text-muted-foreground">
								{connectionLabel(node)} / {executionNodeStatus(node)}
							</p>
							{#if node.lastError}<p class="mt-1 break-words text-xs text-destructive">
									{node.lastError.message}
								</p>{/if}
						</div>
						{#if node.kind === 'remote'}
							<Button
								variant="ghost"
								size="icon-sm"
								aria-label={`Edit ${node.label}`}
								title={`Edit ${node.label}`}
								onclick={() => beginEdit(node)}><Pencil class="size-4" /></Button
							>
						{/if}
					</li>
					{#snippet failed()}<li class="py-3 text-sm text-destructive">
							Unable to display node
						</li>{/snippet}
				</svelte:boundary>
			{/each}
		</ul>
	{:else}
		<form
			class="space-y-4"
			onsubmit={(event) => {
				event.preventDefault();
				if (!editor.confirmDelete) void editor.save();
			}}
		>
			<div class="flex items-center gap-2">
				<Button
					type="button"
					variant="ghost"
					size="icon-sm"
					onclick={closeEditor}
					aria-label="Back to nodes"
					title="Back to nodes"><ArrowLeft class="size-4" /></Button
				>
				<h3 class="text-sm font-medium">{editor.id ? 'Edit Node' : 'Add Node'}</h3>
			</div>
			<label class="block space-y-1 text-sm"
				>Label<input
					id="execution-node-label"
					class={`${inputClass} text-base pointer-fine:text-sm`}
					bind:value={editor.label}
					required
					maxlength="100"
					disabled={editor.busy}
				/></label
			>
			<label class="block space-y-1 text-sm"
				>Connection direction
				<select
					id="execution-node-direction"
					class={`${inputClass} text-base pointer-fine:text-sm`}
					bind:value={editor.direction}
					disabled={editor.busy}
				>
					<option value="node-connects">Node connects to controller</option>
					<option value="controller-connects">Controller connects to node</option>
				</select>
			</label>
			{#if editor.id || editor.direction === 'controller-connects'}
				<label class="block space-y-1 text-sm"
					>Connection URL
					<input
						id="execution-node-url"
						class={`${inputClass} text-base pointer-fine:text-sm`}
						type="text"
						bind:value={editor.connectionUrl}
						required
						autocomplete="off"
						spellcheck={false}
						disabled={editor.busy}
						aria-describedby={editor.withoutTls ? 'execution-node-tls-warning' : undefined}
					/>
				</label>
				{#if editor.withoutTls}
					<p id="execution-node-tls-warning" role="alert" class="text-sm text-destructive">
						TLS is disabled. Noise encrypts execution traffic, but connection metadata remains
						exposed. Use only on a private network you trust.
					</p>
				{/if}
				<div class="flex items-center gap-2">
					<Button
						type="button"
						variant="outline"
						size="icon-sm"
						title="Copy connection URL"
						aria-label="Copy connection URL"
						disabled={!editor.connectionUrl}
						onclick={copyConnectionUrl}><Copy class="size-4" /></Button
					>
					{#if copied}<span role="status" class="text-xs text-muted-foreground">Copied</span>{/if}
				</div>
				<p class="text-xs text-muted-foreground">
					This URL contains a secret. Shell history and startup logs may retain it.
				</p>
			{/if}
			<label class="flex items-center gap-2 text-sm"
				><input
					id="execution-node-insecure"
					type="checkbox"
					bind:checked={editor.allowInsecureDevelopment}
					disabled={editor.busy}
				/>Allow connection without TLS (ws://)</label
			>
			{#if editor.direction === 'controller-connects' && !editor.withoutTls}
				<label class="flex items-center gap-2 text-sm"
					><input
						id="execution-node-unverified-tls"
						type="checkbox"
						bind:checked={editor.allowUnverifiedTls}
						disabled={editor.busy}
					/>Allow unverified TLS certificates</label
				>
				{#if editor.allowUnverifiedTls}
					<p role="alert" class="text-sm text-destructive">
						TLS certificate verification is disabled. Noise still authenticates the peer and
						encrypts execution traffic, but the outer TLS endpoint is not verified.
					</p>
				{/if}
			{/if}
			{#if editor.id}<label class="flex items-center gap-2 text-sm"
					><input
						type="checkbox"
						bind:checked={editor.enabled}
						disabled={editor.busy}
					/>Enabled</label
				>{/if}
			{#if editor.error}<p role="alert" class="break-words text-sm text-destructive">
					{editor.error}
				</p>{/if}
			{#if editor.confirmDelete}
				<p id="execution-node-delete-warning" role="status" class="text-sm text-muted-foreground">
					Chats and saved settings will remain, but this node will be unavailable. Files and
					terminal sessions on the node will not be deleted.
				</p>
			{/if}
			<div class="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-4">
				{#if editor.id && editor.confirmDelete}
					<div class="flex flex-wrap gap-2">
						<Button
							type="button"
							variant="destructive"
							disabled={editor.busy}
							aria-describedby="execution-node-delete-warning"
							onclick={removeNode}>{editor.busy ? 'Deleting...' : 'Delete Node'}</Button
						>
						<Button
							type="button"
							variant="ghost"
							disabled={editor.busy}
							onclick={() => (editor.confirmDelete = false)}>Cancel</Button
						>
					</div>
				{:else if editor.id}
					<Button
						type="button"
						variant="ghost"
						size="icon-sm"
						aria-label="Delete node"
						title="Delete node"
						disabled={editor.busy}
						onclick={() => (editor.confirmDelete = true)}><Trash2 class="size-4" /></Button
					>
				{:else}
					<span></span>
				{/if}
				{#if !editor.confirmDelete}
					<Button
						type="submit"
						disabled={editor.busy || !editor.label.trim()}
						>{saveButtonLabel}</Button
					>
				{/if}
			</div>
		</form>
	{/if}
</div>
