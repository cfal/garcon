<script lang="ts">
	import * as m from '$lib/paraglide/messages.js';
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
		if (editor.busy) return m.common_saving();
		if (editor.id) return m.common_save();
		return m.executors_add();
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
		if (!editor.canCopyConnection) return;
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
			<Button onclick={beginCreate}><Plus class="size-4" />{m.executors_add()}</Button>
		</div>
		{#if executors.error}<p role="alert" class="text-sm text-destructive">{executors.error}</p>{/if}
		{#if executors.loading && executors.executors.length === 0}<p role="status">{m.common_loading()}</p>{/if}
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
								aria-label={m.executors_edit_named({ label: executor.label })}
								title={m.executors_edit_named({ label: executor.label })}
								onclick={() => beginEdit(executor)}><Pencil class="size-4" /></Button
							>
						{/if}
					</li>
					{#snippet failed()}<li class="py-3 text-sm text-destructive">
							{m.executors_display_failed()}
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
					aria-label={m.executors_back()}
					title={m.executors_back()}><ArrowLeft class="size-4" /></Button
				>
				<h3 class="text-sm font-medium">{editor.id ? m.executors_edit() : m.executors_add()}</h3>
			</div>
			<label class="block space-y-1 text-sm"
				>{m.executors_name()}<input
					id="executor-label"
					class={`${inputClass} text-base pointer-fine:text-sm`}
					bind:value={editor.label}
					required
					maxlength="100"
					disabled={editor.busy}
				/></label
			>
			<label class="block space-y-1 text-sm"
				>{m.executors_connection_direction()}
				<select
					id="executor-direction"
					class={`${inputClass} text-base pointer-fine:text-sm`}
					bind:value={editor.direction}
					disabled={editor.busy}
				>
					<option value="executor-connects">{m.executors_worker_connects()}</option>
					<option value="controller-connects">{m.executors_controller_connects()}</option>
				</select>
			</label>
			{#if editor.id || editor.direction === 'controller-connects'}
				<label class="block space-y-1 text-sm"
					>{m.executors_connection_url()}
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
						{m.executors_no_tls_warning()}
					</p>
				{/if}
				<div class="flex items-center gap-2">
					<Button
						type="button"
						variant="outline"
						size="icon-sm"
						title={m.executors_copy_url()}
						aria-label={m.executors_copy_url()}
						disabled={!editor.canCopyConnection}
						onclick={copyConnectionUrl}><Copy class="size-4" /></Button
					>
					{#if copied}<span role="status" class="text-xs text-muted-foreground">{m.common_copied()}</span>{/if}
				</div>
				<p class="text-xs text-muted-foreground">
					{m.executors_secret_warning()}
				</p>
			{/if}
			<label class="flex items-center gap-2 text-sm"
				><input
					id="executor-insecure"
					type="checkbox"
					bind:checked={editor.noTls}
					disabled={editor.busy}
				/>{m.executors_allow_no_tls()}</label
			>
			{#if editor.direction === 'controller-connects' && !editor.withoutTls}
				<label class="flex items-center gap-2 text-sm"
					><input
						id="executor-unverified-tls"
						type="checkbox"
						bind:checked={editor.allowUnverifiedTls}
						disabled={editor.busy}
					/>{m.executors_allow_unverified_tls()}</label
				>
				{#if editor.allowUnverifiedTls}
					<p role="alert" class="text-sm text-destructive">
						{m.executors_unverified_tls_warning()}
					</p>
				{/if}
			{/if}
			{#if editor.id}<label class="flex items-center gap-2 text-sm"
					><input
						type="checkbox"
						bind:checked={editor.enabled}
						disabled={editor.busy}
					/>{m.executors_enabled()}</label
				>{/if}
			<label class="flex items-center gap-2 text-sm">
				<input type="checkbox" bind:checked={editor.allowControllerCli} disabled={editor.busy} aria-describedby="executor-cli-warning" />
				{m.executors_allow_cli()}
			</label>
			<p id="executor-cli-warning" class="text-xs text-muted-foreground">
				{m.executors_cli_warning()}
			</p>
			<label class="flex items-center gap-2 text-sm">
				<input type="checkbox" bind:checked={editor.allowExecutorManagement} disabled={editor.busy} aria-describedby="executor-management-warning" />
				{m.executors_allow_management()}
			</label>
			<p id="executor-management-warning" class="text-xs text-muted-foreground">
				{m.executors_management_warning()}
			</p>
			{#if editor.error}<p role="alert" class="break-words text-sm text-destructive">
					{editor.error}
				</p>{/if}
			{#if editor.confirmDelete}
				<p id="executor-delete-warning" role="status" class="text-sm text-muted-foreground">
					{m.executors_delete_warning()}
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
							onclick={removeExecutor}>{editor.busy ? m.common_deleting() : m.executors_delete_confirm()}</Button
						>
						<Button
							type="button"
							variant="ghost"
							disabled={editor.busy}
							onclick={() => (editor.confirmDelete = false)}>{m.common_cancel()}</Button
						>
					</div>
				{:else if editor.id}
					<Button
						type="button"
						variant="ghost"
						size="icon-sm"
						aria-label={m.executors_delete()}
						title={m.executors_delete()}
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
