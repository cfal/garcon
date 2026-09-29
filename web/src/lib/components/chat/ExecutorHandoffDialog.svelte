<script lang="ts">
	import * as Dialog from '$lib/components/ui/dialog';
	import { Button } from '$lib/components/ui/button';
	import { onDestroy, untrack } from 'svelte';
	import {
		getExecutors,
		getModelCatalog,
		getLocalSettings,
		getAppShell,
		getChatSessions,
		getRemoteSettings,
	} from '$lib/context';
	import { effectiveExecutorId } from '$shared/executors';
	import ComposerModelSelector from '$lib/components/model-selector/ComposerModelSelector.svelte';
	import GitWorktreePickerModal from '$lib/components/git/GitWorktreePickerModal.svelte';
	import DirectoryBrowser from './DirectoryBrowser.svelte';
	import ProjectPinnedPathList from './ProjectPinnedPathList.svelte';
	import ProjectPinnedPathToggleButton from './ProjectPinnedPathToggleButton.svelte';
	import FolderOpen from '@lucide/svelte/icons/folder-open';
	import Loader2 from '@lucide/svelte/icons/loader-2';
	import Check from '@lucide/svelte/icons/check';
	import X from '@lucide/svelte/icons/x';
	import { isDirectAgentId, nonDirectAgentIds } from '$lib/agents/direct-agents';
	import { ProjectPathDialogState } from '$lib/chat/project-paths/project-path-dialog-state.svelte.js';
	import { isPinnedProjectPath } from '$lib/chat/project-paths/project-pinned-paths.js';
	import {
		executorPinnedProjectPaths,
		togglePinnedProjectPathOptimistically,
	} from '$lib/chat/project-paths/pinned-project-path-settings.js';
	import type { ExecutorHandoffProjectState } from '$lib/chat/conversation/executor-handoff-project.svelte.js';
	import type { ModelSelectorChange } from '$lib/components/model-selector/model-selector-types';
	import * as m from '$lib/paraglide/messages.js';
	let { handoff }: { handoff: ExecutorHandoffProjectState } = $props();
	const executors = getExecutors();
	const shell = getAppShell();
	const rootCatalog = getModelCatalog();
	const localSettings = getLocalSettings();
	const remoteSettings = getRemoteSettings();
	const sessions = getChatSessions();
	const destination = new ProjectPathDialogState(executors);
	let isUpdatingPinnedPath = $state(false);
	let confirmedPath = $state('');
	const executorId = $derived(handoff.target?.executorId ?? 'local');
	// A destination on the chat's own executor only replaces an unavailable folder.
	const choosingFolder = $derived(
		handoff.target !== null &&
			effectiveExecutorId(sessions.byId[handoff.target.chatId]?.executorId) === executorId,
	);
	const catalog = $derived(rootCatalog.forExecutor(executorId));
	const basePath = $derived(executors.get(executorId)?.projectBasePath ?? '');
	const filesAvailable = $derived(executors.filesAvailable(executorId));
	const pinnedProjectPaths = $derived(
		executorPinnedProjectPaths(remoteSettings.snapshot, executorId),
	);
	const pathLocked = $derived(handoff.checking || isUpdatingPinnedPath);
	const canConfirm = $derived(
		handoff.canConfirm &&
			destination.validationStatus === 'valid' &&
			Boolean(destination.trimmedPath),
	);
	// A failed confirmation describes the path it checked, not later edits.
	const confirmError = $derived(
		handoff.error && destination.trimmedPath === confirmedPath ? handoff.error : null,
	);
	const agents = $derived(
		localSettings.allowDirectChats || isDirectAgentId(handoff.selection?.agentId ?? '')
			? catalog.getSelectableAgents()
			: nonDirectAgentIds(catalog.getSelectableAgents()),
	);
	// A destination has no current path, so each request validates its suggested
	// folder like an edit; a new executor also replaces the browser and worktrees.
	$effect(() => {
		const target = handoff.target;
		untrack(() => {
			if (target) destination.open('', target.executorId, handoff.initialProjectPath);
			else destination.close();
		});
	});
	$effect(() => {
		if (!handoff.target) return;
		void destination.trimmedPath;
		const contextKey = executors.pathContextKey(executorId);
		untrack(() => destination.scheduleValidation(contextKey));
	});
	$effect(() => {
		if (!handoff.target || !executors.isReady(executorId)) return;
		void catalog.version;
		untrack(() => {
			void catalog.refreshIfStale();
		});
	});
	onDestroy(() => destination.dispose());

	function handleModelChange(selection: ModelSelectorChange): void {
		if (selection.executorId === executorId) handoff.selection = selection;
	}

	function selectPinnedPath(path: string): void {
		if (pathLocked) return;
		destination.setCandidatePath(path);
		destination.showBrowser = false;
	}

	async function togglePinnedPath(): Promise<void> {
		const path = destination.trimmedPath;
		if (!path || isUpdatingPinnedPath) return;
		isUpdatingPinnedPath = true;
		try {
			await togglePinnedProjectPathOptimistically(remoteSettings, path, { executorId });
		} catch (error) {
			console.warn('[ExecutorHandoffDialog] Failed to update pinned project paths', error);
		} finally {
			isUpdatingPinnedPath = false;
		}
	}

	function handleSubmit(event: SubmitEvent): void {
		event.preventDefault();
		if (!canConfirm) return;
		confirmedPath = destination.trimmedPath;
		destination.showBrowser = false;
		void handoff.confirm(confirmedPath);
	}
</script>

<Dialog.Root
	open={handoff.target !== null}
	onOpenChange={(open) => {
		if (!open) handoff.cancel();
	}}
>
	<Dialog.Content class="sm:max-w-lg">
		<Dialog.Header>
			<Dialog.Title>
				{choosingFolder
					? m.chat_executor_handoff_folder_title()
					: m.chat_executor_handoff_title({ label: executors.label(handoff.target?.executorId) })}
			</Dialog.Title>
			<Dialog.Description>{m.chat_executor_handoff_description()}</Dialog.Description>
		</Dialog.Header>
		<form class="min-w-0 space-y-4" onsubmit={handleSubmit}>
			<div class="space-y-1">
				<label for="handoff-path" class="text-sm">{m.chat_executor_handoff_project_label()}</label>
				<div class="relative">
					<div class="flex gap-2">
						<div class="relative min-w-0 flex-1">
							<input
								id="handoff-path"
								class="h-10 w-full rounded-md border border-input bg-background pl-3 pr-9 text-base pointer-fine:text-sm"
								bind:value={destination.candidatePath}
								placeholder={basePath}
								required
								disabled={handoff.checking}
								readonly={isUpdatingPinnedPath}
								aria-invalid={destination.validationStatus === 'invalid'}
								aria-describedby="handoff-path-feedback"
							/>
							{#if destination.trimmedPath}
								<div class="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2">
									{#if destination.validationStatus === 'checking'}
										<Loader2 class="size-4 animate-spin text-muted-foreground" />
									{:else if destination.validationStatus === 'valid'}
										<Check class="size-4 text-status-success-foreground" />
									{:else if destination.validationStatus === 'invalid'}
										<X class="size-4 text-destructive" />
									{/if}
								</div>
							{/if}
						</div>
						<ProjectPinnedPathToggleButton
							isPinned={isPinnedProjectPath(pinnedProjectPaths, destination.trimmedPath)}
							disabled={!destination.trimmedPath || handoff.checking}
							loading={isUpdatingPinnedPath}
							class="size-10 shrink-0 rounded-md border border-border text-muted-foreground hover:bg-muted/50 hover:text-foreground"
							onToggle={togglePinnedPath}
						/>
						<Button
							type="button"
							variant="outline"
							size="icon-lg"
							class="shrink-0"
							title={m.chat_executor_handoff_browse()}
							aria-label={m.chat_executor_handoff_browse()}
							disabled={pathLocked || !filesAvailable}
							onclick={() => (destination.showBrowser = !destination.showBrowser)}
						>
							<FolderOpen class="size-4" />
						</Button>
					</div>
					{#if destination.showBrowser && filesAvailable && !pathLocked}
						<DirectoryBrowser
							{executorId}
							executorContextKey={executors.pathContextKey(executorId)}
							{basePath}
							isMobile={shell.isMobile}
							currentPath={destination.trimmedPath || basePath}
							onSelect={(path) => destination.setCandidatePath(path)}
							onClose={() => (destination.showBrowser = false)}
						/>
					{/if}
				</div>
				<div id="handoff-path-feedback" class="min-h-5">
					{#if destination.validationStatus === 'invalid' && destination.validationError}
						<p class="text-xs text-destructive">{destination.validationError}</p>
					{:else if destination.canSelectWorktree}
						<button
							type="button"
							disabled={pathLocked}
							onclick={() => destination.openWorktreePicker()}
							class="flex items-center gap-1.5 text-xs text-interactive-accent transition-colors hover:underline disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:no-underline"
						>
							{m.chat_new_chat_select_different_worktree()}
						</button>
					{/if}
				</div>
			</div>
			<ProjectPinnedPathList
				{pinnedProjectPaths}
				selectedPath={destination.trimmedPath}
				disabled={pathLocked}
				onSelect={selectPinnedPath}
			/>
			{#if handoff.selection}
				<ComposerModelSelector
					value={{ executorId, ...handoff.selection }}
					mode={{ agent: 'select', source: 'select', surface: 'composer' }}
					getSelectableAgentIds={() => agents}
					disabled={handoff.checking}
					onChange={handleModelChange}
				/>
			{/if}
			{#if !executors.isReady(executorId)}
				<p role="status" class="text-sm text-destructive">
					{m.chat_executor_handoff_executor_unavailable()}
				</p>
			{:else if catalog.error}
				<p role="alert" class="text-sm text-destructive">
					{catalog.error}
					<button type="button" class="underline" onclick={() => void catalog.forceRefresh()}>
						{m.common_retry()}
					</button>
				</p>
			{:else if !catalog.isValidated}
				<p role="status" class="text-sm text-muted-foreground">{m.chat_composer_loading_models()}</p>
			{:else if !handoff.selectionAvailable}
				<p role="status" class="text-sm text-destructive" data-handoff-selection-unavailable>
					{m.chat_executor_handoff_selection_unavailable({ label: executors.label(executorId) })}
				</p>
			{/if}
			{#if confirmError}
				<p role="alert" class="text-sm text-destructive">{confirmError}</p>
			{/if}
			<Dialog.Footer>
				<Button type="button" variant="outline" onclick={() => handoff.cancel()}>
					{m.common_cancel()}
				</Button>
				<Button type="submit" disabled={!canConfirm}>
					{#if handoff.checking}
						{m.chat_executor_handoff_checking()}
					{:else if choosingFolder}
						{m.chat_executor_handoff_folder_confirm()}
					{:else}
						{m.chat_executor_handoff_confirm()}
					{/if}
				</Button>
			</Dialog.Footer>
		</form>
		{#if destination.worktreePickerOpen}
			<GitWorktreePickerModal
				worktrees={destination.worktrees}
				isLoading={destination.isLoadingWorktrees}
				isCreating={destination.isCreatingWorktree}
				errorMessage={destination.worktreeError}
				onSelect={(path) => destination.selectWorktree(path)}
				onCreate={(path, branch, baseRef) => destination.createWorktree(path, branch, baseRef)}
				onRefresh={() => void destination.loadWorktrees()}
				onClose={() => destination.closeWorktreePicker()}
			/>
		{/if}
	</Dialog.Content>
</Dialog.Root>
