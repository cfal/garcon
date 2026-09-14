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
	import Download from '@lucide/svelte/icons/download';
	import { Button } from '$lib/components/ui/button';
	import type { FileDraft } from '$lib/files/persistence/file-draft-repository.js';
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

	async function openRecoveredFile(draft: FileDraft): Promise<void> {
		try {
			await files.open({
				fileRootPath: draft.canonicalFileRootPath,
				relativePath: draft.normalizedRelativePath,
				mode: 'code',
				origin: presentation,
				reason: 'user-open',
			});
		} catch (error) {
			notifications.error(error instanceof Error ? error.message : m.workspace_open_failed());
		}
	}
</script>

<div class="flex h-full min-h-0 flex-col overflow-hidden">
	{#if files.recoveryError}
		<div class="flex items-center gap-2 border-b border-border p-3 text-xs" role="status">
			<span class="min-w-0 flex-1 break-words"
				>{m.file_recovery_failed({ detail: files.recoveryError })}</span
			>
			<Button variant="outline" size="sm" onclick={() => void files.retryRecoveryDiscovery()}
				>{m.common_retry()}</Button
			>
		</div>
	{/if}
	{#if files.recoveredDrafts.length > 0}
		<section
			class="max-h-48 shrink-0 overflow-y-auto border-b border-border"
			aria-label={m.file_recovered_files()}
		>
			<h2 class="px-3 pt-3 pb-1 text-xs font-medium text-muted-foreground">
				{m.file_recovered_files()}
			</h2>
			{#each files.recoveredDrafts as draft (draft.documentId)}
				<div class="flex items-center gap-1 pr-2">
					<button
						type="button"
						class="flex min-h-10 min-w-0 flex-1 items-center gap-2 px-3 py-2 text-left text-xs hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring focus-visible:-outline-offset-2"
						title={draft.canonicalFileRootPath + '/' + draft.normalizedRelativePath}
						onclick={() => void openRecoveredFile(draft)}
					>
						<FileText class="size-4 shrink-0 text-muted-foreground" />
						<span class="min-w-0 break-all">{draft.normalizedRelativePath}</span>
					</button>
					<Button
						variant="ghost"
						size="icon-sm"
						onclick={() => files.exportDraft(draft.documentId)}
						aria-label={m.file_recovery_export_draft({ fileName: draft.normalizedRelativePath })}
						title={m.file_session_export_local_copy()}
					>
						<Download class="size-4" />
					</Button>
				</div>
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
