<script lang="ts">
	import FileTree from './FileTree.svelte';
	import type { FileTreeEntry } from '$shared/file-contracts';
	import { getFileSessions, getSingletonSurfaces } from '$lib/context';
	import type { HostId } from '$lib/workspace/surface-types.js';

	let { presentation }: { presentation: HostId | 'mobile' } = $props();

	const files = getFileSessions();
	const tree = getSingletonSurfaces().files().tree;

	function handleFileSelect(node: FileTreeEntry): void {
		const fileRootPath = tree.fileRootPath;
		if (!fileRootPath) return;
		void files.open({
			fileRootPath,
			relativePath: node.relativePath,
			mode: 'auto',
			origin: presentation,
			reason: 'user-open',
		});
	}
</script>

<div class="flex h-full min-h-0 flex-col overflow-hidden">
	<div class="min-h-0 flex-1">
		<FileTree
			store={tree}
			{presentation}
			onFileSelect={handleFileSelect}
			onImageSelect={handleFileSelect}
		/>
	</div>
</div>
