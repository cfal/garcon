<script lang="ts">
	import FileTree from './FileTree.svelte';
	import type { FileTreeEntry } from '$shared/file-contracts';
	import {
		getFileSessions,
		getNotifications,
		getSingletonSurfaces,
		getWorkspaceCoordinator,
	} from '$lib/context';
	import type { WorkspaceWindowId } from '$lib/workspace/surface-types.js';
	import type { WorkspaceProjectState } from '$lib/workspace/workspace-context.svelte.js';
	import type { ProjectTarget } from '$shared/project-resolution';
	import ProjectSurfaceGate from '$lib/components/workspace/ProjectSurfaceGate.svelte';
	import { filePathRelativeToTreeRoot } from '$lib/files/tree/file-tree-path.js';
	import FileText from '@lucide/svelte/icons/file-text';
	import * as m from '$lib/paraglide/messages.js';

	let {
		presentation,
		projectState,
		target,
		onChooseProjectFolder,
	}: {
		presentation: WorkspaceWindowId | 'mobile';
		projectState: WorkspaceProjectState;
		target: ProjectTarget | null;
		onChooseProjectFolder?: () => void;
	} = $props();

	const files = getFileSessions();
	const notifications = getNotifications();
	const workspace = getWorkspaceCoordinator();
	const tree = getSingletonSurfaces().files().tree;
	const recoveredFiles = $derived.by(() => {
		if (presentation !== 'mobile') return [];
		const documentIds = new Set<string>();
		return files.all.filter((session) => {
			if (!session.document.recovered || (!session.dirty && !session.saveOutcomeUnknown))
				return false;
			if (documentIds.has(session.documentId)) return false;
			documentIds.add(session.documentId);
			return true;
		});
	});
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

	async function openRecoveredFile(sessionId: string): Promise<void> {
		try {
			await workspace.focusFileSession(sessionId);
		} catch (error) {
			notifications.error(error instanceof Error ? error.message : m.workspace_open_failed());
		}
	}
</script>

<div class="flex h-full min-h-0 flex-col overflow-hidden">
	{#if recoveredFiles.length > 0}
		<section
			class="max-h-48 shrink-0 overflow-y-auto border-b border-border"
			aria-label={m.file_recovered_files()}
		>
			<h2 class="px-3 pt-3 pb-1 text-xs font-medium text-muted-foreground">
				{m.file_recovered_files()}
			</h2>
			{#each recoveredFiles as session (session.documentId)}
				<button
					type="button"
					class="flex min-h-10 w-full items-center gap-2 px-3 py-2 text-left text-xs hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring focus-visible:-outline-offset-2"
					title={session.fullPath}
					onclick={() => void openRecoveredFile(session.id)}
				>
					<FileText class="size-4 shrink-0 text-muted-foreground" />
					<span class="min-w-0 break-all">{session.fullPath}</span>
				</button>
			{/each}
		</section>
	{/if}
	<div class="min-h-0 min-w-0 flex-1">
		<!-- Recovered drafts remain accessible even when their project folder is unavailable. -->
		<ProjectSurfaceGate
			{projectState}
			{target}
			retainedProjectPath={tree.projectPath}
			retainedEffectiveProjectKey={tree.effectiveProjectKey}
			onChooseFolder={onChooseProjectFolder}
		>
			<FileTree
				{selectedPath}
				store={tree}
				onFileSelect={handleFileSelect}
				onImageSelect={handleFileSelect}
			/>
		</ProjectSurfaceGate>
	</div>
</div>
