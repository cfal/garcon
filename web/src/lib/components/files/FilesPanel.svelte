<script lang="ts">
	import FileTree from './FileTree.svelte';
	import type { FileTreeEntry } from '$shared/file-contracts';
	import { getFileSessions, getSingletonSurfaces } from '$lib/context';

	const files = getFileSessions();
	const tree = getSingletonSurfaces().files().tree;

	function handleFileSelect(node: FileTreeEntry): void {
		const fileRootPath = tree.fileRootPath;
		if (!fileRootPath) return;
		void files.open({
			fileRootPath,
			relativePath: node.relativePath,
			mode: 'auto',
			reason: 'user-open',
		});
	}
</script>

<div class="flex h-full min-h-0 flex-col overflow-hidden">
	<div class="min-h-0 flex-1">
		<FileTree store={tree} onFileSelect={handleFileSelect} onImageSelect={handleFileSelect} />
	</div>
</div>
