<script lang="ts">
	import FileTree from './FileTree.svelte';
	import type { FileTreeNode } from '$lib/api/files';
	import { getFileSessions } from '$lib/context';
	import type { WorkspaceProjectState } from '$lib/workspace/workspace-context.svelte.js';

	interface FilesPanelProps {
		projectState: WorkspaceProjectState;
	}

	let { projectState }: FilesPanelProps = $props();

	const files = getFileSessions();

	function handleFileSelect(node: FileTreeNode): void {
		if (projectState.kind !== 'available') return;
		const { chatId, projectPath } = projectState.project;
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
	<div class="min-h-0 flex-1">
		<FileTree onFileSelect={handleFileSelect} onImageSelect={handleFileSelect} />
	</div>
</div>
