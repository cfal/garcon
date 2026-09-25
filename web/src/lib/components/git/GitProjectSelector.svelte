<script lang="ts">
	import type { Snippet } from 'svelte';
	import Folder from '@lucide/svelte/icons/folder';
	import LocateFixed from '@lucide/svelte/icons/locate-fixed';
	import ExecutorSelector from '$lib/components/shared/ExecutorSelector.svelte';
	import GitTargetDialog from './GitTargetDialog.svelte';
	import { getRemoteSettings, getTransientLayers, getExecutors } from '$lib/context';
	import { togglePinnedProjectPathOptimistically } from '$lib/chat/project-paths/pinned-project-path-settings.js';
	import type { GitProjectSelectionController } from '$lib/git/targets/git-project-selection.svelte.js';
	import type { GitTargetCandidate } from '$lib/api/git.js';
	import * as m from '$lib/paraglide/messages.js';

	let {
		selection,
		path,
		isMobile,
		disabled = false,
		onSelectExecutor,
		onSelectFolder,
		onGoToChatProject,
		children,
	}: {
		selection: GitProjectSelectionController;
		path: string | null;
		isMobile: boolean;
		disabled?: boolean;
		onSelectExecutor: (executorId: string) => void;
		onSelectFolder: (candidate: GitTargetCandidate) => void;
		onGoToChatProject: () => void;
		children?: Snippet;
	} = $props();
	const executors = getExecutors();
	const remoteSettings = getRemoteSettings();
	const transientLayers = getTransientLayers();
	const executorId = $derived(selection.executorId);
	const selectedPath = $derived(
		selection.projectState.kind === 'available' ? path : selection.projectPath,
	);
	const folderLabel = $derived(selectedPath || m.git_panel_select_project());
	const canSelectFolder = $derived(!disabled && executors.gitAvailable(executorId));
	const projectBasePath = $derived(
		executors.get(executorId)?.projectBasePath ??
			(executorId === 'local' ? remoteSettings.snapshot?.projectBasePath : null) ??
			'/',
	);
	const pinnedProjectPaths = $derived(
		(executorId === 'local'
			? remoteSettings.snapshot?.paths.pinnedProjectPaths
			: remoteSettings.snapshot?.paths.byExecutor?.[executorId]?.pinnedPaths) ?? [],
	);

	function openFolder(): void {
		if (!canSelectFolder) return;
		void remoteSettings.ensureLoadedInBackground();
		transientLayers.open('main-inert', () => {
			selection.showFolderDialog = true;
		});
	}
</script>

<div class="flex min-w-0 flex-1 items-center gap-1" data-git-project-selector>
	<ExecutorSelector
		{executors}
		{executorId}
		service="git"
		class="min-w-26"
		{disabled}
		onSelect={onSelectExecutor}
	/>
	{@render children?.()}
	<button
		type="button"
		class="inline-flex h-8 min-w-8 max-w-48 items-center gap-1.5 rounded-lg px-2 text-xs text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
		onclick={openFolder}
		disabled={!canSelectFolder}
		aria-label={folderLabel}
		title={folderLabel}
		data-git-folder-picker
	>
		<Folder class="size-4 shrink-0 text-file-icon-folder" />
		<span class="min-w-0 truncate">{folderLabel}</span>
	</button>
	{#if !selection.followingChat && selection.canGoToChatProject}
		<button
			type="button"
			class="inline-flex size-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
			{disabled}
			onclick={onGoToChatProject}
			aria-label={m.filetree_go_to_chat_project()}
			title={m.filetree_go_to_chat_project()}
		>
			<LocateFixed class="size-4" />
		</button>
	{/if}
</div>

{#if selection.showFolderDialog}
	<GitTargetDialog
		{executorId}
		{isMobile}
		initialPath={selectedPath || projectBasePath}
		{projectBasePath}
		{pinnedProjectPaths}
		onConfirm={onSelectFolder}
		onClose={() => {
			selection.showFolderDialog = false;
		}}
		onTogglePinnedProjectPath={(folder) =>
			void togglePinnedProjectPathOptimistically(remoteSettings, folder, { executorId })}
	/>
{/if}
