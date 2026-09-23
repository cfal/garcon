<script lang="ts">
	import type { Snippet } from 'svelte';
	import Folder from '@lucide/svelte/icons/folder';
	import LocateFixed from '@lucide/svelte/icons/locate-fixed';
	import ExecutionNodeSelector from '$lib/components/shared/ExecutionNodeSelector.svelte';
	import GitTargetDialog from './GitTargetDialog.svelte';
	import { getRemoteSettings, getTransientLayers, getExecutionNodes } from '$lib/context';
	import { togglePinnedProjectPathOptimistically } from '$lib/chat/project-paths/pinned-project-path-settings.js';
	import type { GitProjectSelectionController } from '$lib/git/targets/git-project-selection.svelte.js';
	import type { GitTargetCandidate } from '$lib/api/git.js';
	import * as m from '$lib/paraglide/messages.js';

	let {
		selection,
		path,
		isMobile,
		disabled = false,
		onSelectNode,
		onSelectFolder,
		onGoToChatProject,
		children,
	}: {
		selection: GitProjectSelectionController;
		path: string | null;
		isMobile: boolean;
		disabled?: boolean;
		onSelectNode: (nodeId: string) => void;
		onSelectFolder: (candidate: GitTargetCandidate) => void;
		onGoToChatProject: () => void;
		children?: Snippet;
	} = $props();
	const nodes = getExecutionNodes();
	const remoteSettings = getRemoteSettings();
	const transientLayers = getTransientLayers();
	const nodeId = $derived(selection.nodeId);
	const selectedPath = $derived(
		selection.projectState.kind === 'available' ? path : selection.projectPath,
	);
	const projectBasePath = $derived(
		nodes.get(nodeId)?.projectBasePath ??
			(nodeId === 'local' ? remoteSettings.snapshot?.projectBasePath : null) ??
			'/',
	);
	const pinnedProjectPaths = $derived(
		(nodeId === 'local'
			? remoteSettings.snapshot?.paths.pinnedProjectPaths
			: remoteSettings.snapshot?.paths.byNode?.[nodeId]?.pinnedPaths) ?? [],
	);

	function openFolder(): void {
		if (disabled || !nodes.gitAvailable(nodeId)) return;
		void remoteSettings.ensureLoadedInBackground();
		transientLayers.open('main-inert', () => {
			selection.showFolderDialog = true;
		});
	}
</script>

<div class="flex min-w-0 flex-1 items-center gap-1" data-git-project-selector>
	<ExecutionNodeSelector
		{nodes}
		{nodeId}
		service="git"
		class="min-w-26"
		{disabled}
		onSelect={onSelectNode}
	/>
	{@render children?.()}
	<button
		type="button"
		class="inline-flex h-8 min-w-8 max-w-48 items-center gap-1.5 rounded-lg px-2 text-xs text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
		onclick={openFolder}
		disabled={disabled || !nodes.gitAvailable(nodeId)}
		aria-label={selectedPath || m.git_panel_select_project()}
		title={selectedPath || m.git_panel_select_project()}
		data-git-folder-picker
	>
		<Folder class="size-4 shrink-0 text-file-icon-folder" />
		<span class="min-w-0 truncate">{selectedPath || m.git_panel_select_project()}</span>
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
		{nodeId}
		{isMobile}
		initialPath={selectedPath || projectBasePath}
		{projectBasePath}
		{pinnedProjectPaths}
		onConfirm={onSelectFolder}
		onClose={() => {
			selection.showFolderDialog = false;
		}}
		onTogglePinnedProjectPath={(folder) =>
			void togglePinnedProjectPathOptimistically(remoteSettings, folder, { nodeId })}
	/>
{/if}
