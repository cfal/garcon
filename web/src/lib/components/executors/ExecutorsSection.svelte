<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import Plus from '@lucide/svelte/icons/plus';
	import Pencil from '@lucide/svelte/icons/pencil';
	import Copy from '@lucide/svelte/icons/copy';
	import Trash2 from '@lucide/svelte/icons/trash-2';
	import ArrowLeft from '@lucide/svelte/icons/arrow-left';
	import { Button } from '$lib/components/ui/button';
	import { getExecutors } from '$lib/context';
	import { executorStatus } from '$lib/executors/executors-store.svelte.js';
	import { copyToClipboard } from '$lib/utils/clipboard';
	import type { ExecutorSnapshot } from '$shared/executors';
	import { ExecutorEditor } from './executor-editor.svelte.js';

	const executors = getExecutors();
	const editor = new ExecutorEditor(executors);
	let editorOpen = $state(false);
	let copied = $state(false);
	let content = $state<HTMLElement | null>(null);
	const inputClass = 'h-10 w-full min-w-0 rounded-md border border-input bg-background px-3';
	const saveButtonLabel = $derived.by(() => {
		if (editor.busy) return 'Saving...';
		if (editor.id) return 'Save';
		return 'Add Executor';
	});

	onMount(() => {
		void executors.refresh();
	});
	onDestroy(() => editor.clear());

	function beginCreate(): void {
		editor.clear();
		editorOpen = true;
	}

	function beginEdit(executor: ExecutorSnapshot): void {
		editorOpen = true;
		void editor.edit(executor);
	}

	function closeEditor(): void {
		editor.clear();
		editorOpen = false;
		copied = false;
	}

	async function removeExecutor(): Promise<void> {
		if (await editor.remove()) closeEditor();
	}

	async function copyConnectionUrl(): Promise<void> {
		const url = editor.connectionUrl;
		copied = await copyToClipboard(url, content ?? undefined, () => editor.connectionUrl === url);
		if (!copied) editor.error = 'Unable to copy connection URL';
	}

	function connectionLabel(executor: ExecutorSnapshot): string {
		if (executor.kind === 'local') return 'Local';
		if (executor.direction === 'executor-connects') return 'Executor connects to controller';
		return 'Controller connects to executor';
	}
</script>

<div bind:this={content} class="min-w-0 space-y-4">
	{#if !editorOpen}
		<div class="flex justify-end">
			<Button onclick={beginCreate}><Plus class="size-4" />Add Executor</Button>
		</div>
		{#if executors.error}<p role="alert" class="text-sm text-destructive">{executors.error}</p>{/if}
		{#if executors.loading && executors.executors.length === 0}<p role="status">Loading...</p>{/if}
		<ul class="divide-y divide-border border-y border-border">
			{#each executors.executors as executor (executor.id)}
				<svelte:boundary>
					<li class="flex min-w-0 items-center gap-3 py-3">
						<div class="min-w-0 flex-1">
							<div class="break-words text-sm font-medium">{executor.label}</div>
							<p class="text-xs text-muted-foreground">
								{connectionLabel(executor)} / {executorStatus(executor)}
							</p>
							{#if executor.lastError}<p class="mt-1 break-words text-xs text-destructive">
									{executor.lastError.message}
								</p>{/if}
						</div>
						{#if executor.kind === 'remote'}
							<Button
								variant="ghost"
								size="icon-sm"
								aria-label={`Edit ${executor.label}`}
								title={`Edit ${executor.label}`}
								onclick={() => beginEdit(executor)}><Pencil class="size-4" /></Button
							>
						{/if}
					</li>
					{#snippet failed()}<li class="py-3 text-sm text-destructive">
							Unable to display executor
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
					aria-label="Back to executors"
					title="Back to executors"><ArrowLeft class="size-4" /></Button
				>
				<h3 class="text-sm font-medium">{editor.id ? 'Edit Executor' : 'Add Executor'}</h3>
			</div>
			<label class="block space-y-1 text-sm"
				>Label<input
					id="executor-label"
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
					id="executor-direction"
					class={`${inputClass} text-base pointer-fine:text-sm`}
					bind:value={editor.direction}
					disabled={editor.busy}
				>
					<option value="executor-connects">Executor connects to controller</option>
					<option value="controller-connects">Controller connects to executor</option>
				</select>
			</label>
			{#if editor.id || editor.direction === 'controller-connects'}
				<label class="block space-y-1 text-sm"
					>Connection URL
					<input
						id="executor-url"
						class={`${inputClass} text-base pointer-fine:text-sm`}
						type="text"
						bind:value={editor.connectionUrl}
						required
						autocomplete="off"
						spellcheck={false}
						disabled={editor.busy}
						aria-describedby={editor.withoutTls ? 'executor-tls-warning' : undefined}
					/>
				</label>
				{#if editor.withoutTls}
					<p id="executor-tls-warning" role="alert" class="text-sm text-destructive">
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
					id="executor-insecure"
					type="checkbox"
					bind:checked={editor.allowInsecureDevelopment}
					disabled={editor.busy}
				/>Allow connection without TLS (ws://)</label
			>
			{#if editor.direction === 'controller-connects' && !editor.withoutTls}
				<label class="flex items-center gap-2 text-sm"
					><input
						id="executor-unverified-tls"
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
			<label class="flex items-center gap-2 text-sm">
				<input type="checkbox" bind:checked={editor.allowControllerCli} disabled={editor.busy} aria-describedby="executor-cli-warning" />
				Allow workspace CLI access
			</label>
			<p id="executor-cli-warning" class="text-xs text-muted-foreground">
				Trusts every process using this executor's OS account to manage workspace chats and tickets,
				run agents on Local and other executors, and approve permission requests, including bypass execution.
			</p>
			{#if editor.error}<p role="alert" class="break-words text-sm text-destructive">
					{editor.error}
				</p>{/if}
			{#if editor.confirmDelete}
				<p id="executor-delete-warning" role="status" class="text-sm text-muted-foreground">
					Chats and saved settings will remain, but this executor will be unavailable. Files and
					terminal sessions on the executor will not be deleted.
				</p>
			{/if}
			<div class="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-4">
				{#if editor.id && editor.confirmDelete}
					<div class="flex flex-wrap gap-2">
						<Button
							type="button"
							variant="destructive"
							disabled={editor.busy}
							aria-describedby="executor-delete-warning"
							onclick={removeExecutor}>{editor.busy ? 'Deleting...' : 'Delete Executor'}</Button
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
						aria-label="Delete executor"
						title="Delete executor"
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
