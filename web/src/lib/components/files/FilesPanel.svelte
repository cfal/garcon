<script lang="ts">
	import FileTree from './FileTree.svelte';
	import { getFileViewer } from '$lib/context';
	import type { FileTreeNode } from '$lib/api/files';

	interface FilesPanelProps {
		projectPath: string | null;
		chatId: string | null;
	}

	let { projectPath, chatId }: FilesPanelProps = $props();

	const viewer = getFileViewer();

	function handleFileSelect(node: FileTreeNode): void {
		if (!chatId || !projectPath) return;
		viewer.openAuto({
			chatId,
			projectPath,
			relativePath: node.path,
			source: 'files-tree',
		});
	}
</script>

<div class="h-full min-h-0 flex overflow-hidden">
	<div class="flex-1 min-h-0">
		<FileTree
			{projectPath}
			{chatId}
			onFileSelect={handleFileSelect}
			onImageSelect={handleFileSelect}
		/>
	</div>
</div>
