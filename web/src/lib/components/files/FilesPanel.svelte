<script lang="ts">
	import FileTree from './FileTree.svelte';
	import type { FileTreeEntry } from '$shared/file-contracts';
	import { getFileSessions, getSingletonSurfaces, getWorkspaceCoordinator } from '$lib/context';
	import type { WorkspaceWindowId } from '$lib/workspace/surface-types.js';
	import { filePathRelativeToTreeRoot } from '$lib/files/tree/file-tree-path.js';

	let { presentation }: { presentation: WorkspaceWindowId | 'mobile' } = $props();

	const files = getFileSessions();
	const workspace = getWorkspaceCoordinator();
	const tree = getSingletonSurfaces().files().tree;
	const selectedPath = $derived.by(() => {
		const owner = workspace.focusOwner;
		if (owner.kind === 'chat-list') return null;
		const surface = workspace.layout.surface(owner.surfaceId);
		if (surface?.type !== 'file') return null;
		const session = files.get(surface.fileSessionId);
		const treeRoot = tree.fileRootPath;
		return session && treeRoot
			? filePathRelativeToTreeRoot(treeRoot, session.canonicalFileRootPath, session.relativePath)
			: null;
	});

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
	<div class="min-h-0 min-w-0 flex-1">
		<FileTree
			{selectedPath}
			store={tree}
			onFileSelect={handleFileSelect}
			onImageSelect={handleFileSelect}
		/>
	</div>
</div>
