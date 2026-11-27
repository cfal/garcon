<script lang="ts">
	import { onDestroy, untrack } from 'svelte';
	import FolderOpen from '@lucide/svelte/icons/folder-open';
	import { Button } from '$lib/components/ui/button';
	import * as Dialog from '$lib/components/ui/dialog';
	import ExecutorSelector from '$lib/components/shared/ExecutorSelector.svelte';
	import { getExecutors } from '$lib/context';
	import * as files from '$lib/api/files';
	import { MAX_FILE_VIEW_BYTES, type FileTreeResponse } from '$shared/file-contracts';
	import { WorkflowFileState } from '$lib/workflows/definition/workflow-file-state.svelte';
	import type { WorkflowLaunchContext } from '$lib/workflows/launch/workflow-locations';
	import * as m from '$lib/paraglide/messages.js';

	let {
		mode,
		context,
		onOpen,
		onImport,
		onClose,
	}: {
		mode: 'open' | 'import' | 'paste';
		context: WorkflowLaunchContext | null;
		onOpen: (file: WorkflowFileState) => void;
		onImport: (source: string) => void;
		onClose: () => void;
	} = $props();

	const executors = getExecutors();
	const title = $derived(
		mode === 'open'
			? m.workflow_studio_open_file()
			: mode === 'import'
				? m.workflow_studio_import_file()
				: m.workflow_studio_paste(),
	);
	let executorId = $state(untrack(() => context?.executorId ?? 'local'));
	let path = $state('');
	let source = $state('');
	let browserFile = $state<File>();
	let tree = $state.raw<FileTreeResponse>();
	let error = $state<string | null>(null);
	let loading = $state(false);
	let request: AbortController | null = null;

	onDestroy(() => request?.abort());

	function selectExecutor(id: string) {
		request?.abort();
		request = null;
		loading = false;
		executorId = id;
		path = '';
		tree = undefined;
		error = null;
	}

	async function browse(directoryPath?: string) {
		const operation = new AbortController();
		request?.abort();
		request = operation;
		const capturedExecutor = executorId;
		loading = true;
		error = null;
		try {
			const result = await files.getTree(
				{ executorId: capturedExecutor, directoryPath },
				{ signal: operation.signal },
			);
			if (request === operation && !operation.signal.aborted) tree = result;
		} catch (cause) {
			if (!operation.signal.aborted)
				error = cause instanceof Error ? cause.message : m.workflow_studio_read_failed();
		} finally {
			if (request === operation) {
				request = null;
				loading = false;
			}
		}
	}

	async function submit(event: SubmitEvent) {
		event.preventDefault();
		if (loading) return;
		error = null;
		if (mode === 'paste') {
			if (source.trim()) onImport(source);
			return;
		}
		const operation = new AbortController();
		request = operation;
		loading = true;
		try {
			if (mode === 'import' && browserFile) {
				if (browserFile.size > MAX_FILE_VIEW_BYTES) {
					error = m.workflow_studio_import_too_large();
					return;
				}
				const bytes = await browserFile.arrayBuffer();
				if (!operation.signal.aborted)
					onImport(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes));
			} else if (mode === 'open' && path.trim()) {
				const targetPath = path.trim();
				const targetExecutor = executorId;
				const relative = !/^(?:[a-z]:[\\/]|[\\/])/i.test(targetPath);
				const directory =
					tree?.directory.path ??
					(context?.executorId === targetExecutor ? context.cwd : undefined);
				const projectPath =
					(relative ? directory : undefined) ??
					tree?.fileRootPath ??
					executors.get(targetExecutor)?.projectBasePath ??
					(await files.getTree({ executorId: targetExecutor }, { signal: operation.signal }))
						.fileRootPath;
				operation.signal.throwIfAborted();
				const file = await WorkflowFileState.open(
					files,
					{ executorId: targetExecutor, projectPath, filePath: targetPath },
					operation.signal,
				);
				if (operation.signal.aborted) file.dispose();
				else onOpen(file);
			}
		} catch (cause) {
			if (!operation.signal.aborted)
				error = cause instanceof Error ? cause.message : m.workflow_studio_read_failed();
		} finally {
			if (request === operation) {
				request = null;
				loading = false;
			}
		}
	}
</script>

<Dialog.Root
	open
	onOpenChange={(open) => {
		if (!open) onClose();
	}}
>
	<Dialog.Content class="max-h-[85dvh] min-w-0 overflow-auto">
		<Dialog.Header><Dialog.Title>{title}</Dialog.Title></Dialog.Header>
		<form class="space-y-3" onsubmit={submit}>
			{#if mode === 'open'}
				<div class="flex flex-wrap items-center gap-2">
					<span class="text-sm text-muted-foreground">{executors.label(executorId)}</span>
					<ExecutorSelector
						{executors}
						{executorId}
						service="files"
						disabled={loading}
						onSelect={selectExecutor}
					/>
				</div>
				<label class="block space-y-1 text-sm">
					<span>{m.workflow_studio_file_path()}</span>
					<input class="workflow-field text-base" required disabled={loading} bind:value={path} />
				</label>
				<Button
					size="sm"
					variant="outline"
					disabled={loading || !executors.filesAvailable(executorId)}
					onclick={() => void browse(context?.executorId === executorId ? context.cwd : undefined)}
				>
					<FolderOpen class="size-4" />
					{m.workflow_studio_browse_files()}
				</Button>
				{#if tree}
					<div class="max-h-48 min-w-0 overflow-auto border border-border p-2">
						<p class="wrap-anywhere text-xs text-muted-foreground">{tree.directory.path}</p>
						{#if tree.directory.parentPath}
							<Button
								size="sm"
								variant="ghost"
								disabled={loading}
								onclick={() => void browse(tree?.directory.parentPath ?? undefined)}
								>{m.workflow_studio_parent_folder()}</Button
							>
						{/if}
						{#each tree.entries.filter((entry) => entry.type === 'directory' || /\.ya?ml$/i.test(entry.name)) as entry (entry.path)}
							<svelte:boundary>
								<button
									type="button"
									class="block w-full wrap-anywhere px-2 py-1.5 text-left text-sm hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring"
									disabled={loading}
									onclick={() => {
										if (entry.type === 'directory') void browse(entry.path);
										else path = entry.path;
									}}>{entry.name}{entry.type === 'directory' ? '/' : ''}</button
								>
								{#snippet failed()}<p class="text-sm text-destructive">
										{m.workflow_studio_read_failed()}
									</p>{/snippet}
							</svelte:boundary>
						{/each}
					</div>
				{/if}
			{:else if mode === 'import'}
				<label class="block space-y-1 text-sm">
					<span>{m.workflow_studio_yaml_file()}</span>
					<input
						type="file"
						class="workflow-field"
						accept=".yaml,.yml,application/yaml,text/yaml"
						required
						disabled={loading}
						onchange={(event) => (browserFile = event.currentTarget.files?.[0])}
					/>
				</label>
			{:else}
				<label class="block space-y-1 text-sm">
					<span>{m.workflow_studio_source()}</span>
					<textarea
						class="workflow-field min-h-40 font-mono text-base"
						spellcheck={false}
						required
						bind:value={source}></textarea>
				</label>
			{/if}
			{#if error}<p class="wrap-anywhere text-sm text-destructive" role="alert">{error}</p>{/if}
			<div class="flex flex-wrap justify-end gap-2">
				<Button variant="ghost" onclick={onClose}>{m.common_cancel()}</Button>
				<Button
					type="submit"
					disabled={loading ||
						(mode === 'open' ? !path.trim() : mode === 'paste' ? !source.trim() : !browserFile)}
					>{title}</Button
				>
			</div>
		</form>
	</Dialog.Content>
</Dialog.Root>
