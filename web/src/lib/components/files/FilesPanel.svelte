<script lang="ts">
	import FileTree from './FileTree.svelte';
	import { getFileSessions } from '$lib/context';
	import type { FileTreeNode } from '$lib/api/files';
	import FolderOpen from '@lucide/svelte/icons/folder-open';
	import SurfacePlacementMenu from '$lib/components/workspace/SurfacePlacementMenu.svelte';
	import type { HostId } from '$lib/workspace/surface-types.js';
	import * as m from '$lib/paraglide/messages.js';

	interface FilesPanelProps {
		projectPath: string | null;
		chatId: string | null;
		effectiveProjectKey?: string | null;
		isVisible?: boolean;
		presentation: HostId | 'mobile';
	}

	let {
		projectPath,
		chatId,
		effectiveProjectKey = null,
		isVisible = true,
		presentation,
	}: FilesPanelProps = $props();

	const files = getFileSessions();

	function handleFileSelect(node: FileTreeNode): void {
		if (!chatId || !projectPath) return;
		void files.open({
			chatId,
			fileRootPath: projectPath,
			relativePath: node.relativePath,
			mode: 'auto',
			reason: 'user-open',
		});
	}
</script>

<div class="flex h-full min-h-0 flex-col overflow-hidden">
	<div
		class="surface-toolbar flex h-10 shrink-0 items-center justify-between border-b border-border px-3"
		style="container-name: surface-toolbar; container-type: inline-size;"
	>
		<span class="text-xs font-medium text-muted-foreground">{m.workspace_surface_files()}</span>
		<div class="flex shrink-0 items-center gap-1">
			<button
				type="button"
				class="flex h-8 items-center gap-1.5 rounded-md px-2 text-xs text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
				onclick={() => files.showOpenFiles()}
			>
				<FolderOpen class="h-4 w-4" />
				{m.file_session_open_files()}
			</button>
			<SurfacePlacementMenu surfaceId="singleton:files" {presentation} />
		</div>
	</div>
	<div class="min-h-0 flex-1">
		<FileTree
			{projectPath}
			{chatId}
			{effectiveProjectKey}
			{isVisible}
			onFileSelect={handleFileSelect}
			onImageSelect={handleFileSelect}
		/>
	</div>
</div>
