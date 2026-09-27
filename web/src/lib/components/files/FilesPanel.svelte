<script lang="ts">
	import FileTree from './FileTree.svelte';
	import ExecutorSelector from '$lib/components/shared/ExecutorSelector.svelte';
	import type { Snippet } from 'svelte';
	import type { FileTreeEntry } from '$shared/file-contracts';
	import {
		getFileSessions,
		getSingletonSurfaces,
		getWorkspaceCoordinator,
		getExecutors,
	} from '$lib/context';
	import type { WorkspaceWindowId } from '$lib/workspace/surface-types.js';
	import type { WorkspaceProjectState } from '$lib/workspace/workspace-context.svelte.js';
	import type { ProjectTarget } from '$shared/project-resolution';
	import ProjectSurfaceGate from '$lib/components/workspace/ProjectSurfaceGate.svelte';
	import ExecutorServiceNotice from '$lib/components/workspace/ExecutorServiceNotice.svelte';
	import { filePathRelativeToTreeRoot } from '$lib/files/tree/file-tree-path.js';

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
	const workspace = getWorkspaceCoordinator();
	const controller = getSingletonSurfaces().files();
	const tree = controller.tree;
	const executors = getExecutors();
	const selectedPath = $derived.by(() => {
		const owner = workspace.focusOwner;
		if (owner.kind === 'chat-list') return null;
		const surface = workspace.layout.surface(owner.surfaceId);
		if (surface?.type !== 'file') return null;
		const session = files.get(surface.fileSessionId);
		const treeRoot = tree.fileRootPath;
		return session && session.executorId === tree.executorId && treeRoot
			? filePathRelativeToTreeRoot(treeRoot, session.canonicalFileRootPath, session.relativePath)
			: null;
	});

	function handleFileSelect(executor: FileTreeEntry): void {
		const fileRootPath = tree.fileRootPath;
		if (!fileRootPath) return;
		void files.open({
			executorId: tree.executorId,
			fileRootPath,
			relativePath: executor.relativePath,
			mode: 'auto',
			origin: presentation,
			reason: 'user-open',
		});
	}
</script>

{#snippet executorCrumb()}
	<ExecutorSelector
		{executors}
		executorId={tree.executorId}
		service="files"
		class="h-6 max-w-[35%] shrink-0 px-1"
		onSelect={(executorId) => controller.selectExecutor(executorId)}
	/>
{/snippet}

{#snippet contentGate(contents: Snippet)}
	{#if controller.browsingExecutor}
		{#if controller.serviceNotice}
			<div class="grid h-full place-items-center px-6 text-sm">
				<ExecutorServiceNotice notice={controller.serviceNotice} />
			</div>
		{:else}
			{@render contents()}
		{/if}
	{:else}
		<ProjectSurfaceGate
			{projectState}
			{target}
			retainedProjectPath={tree.projectPath}
			retainedEffectiveProjectKey={tree.effectiveProjectKey}
			serviceNotice={controller.serviceNotice}
			onChooseFolder={onChooseProjectFolder}
		>
			<div class="flex h-full min-h-0 flex-col">{@render contents()}</div>
		</ProjectSurfaceGate>
	{/if}
{/snippet}

<div class="flex h-full min-h-0 flex-col overflow-hidden">
	<div class="min-h-0 min-w-0 flex-1">
		<FileTree
			executorCrumb={executors.hasRemoteExecutors || tree.executorId !== 'local'
				? executorCrumb
				: undefined}
			{contentGate}
			onGoToChatProject={() => controller.goToChatProject()}
			canGoToChatProject={controller.canGoToChatProject}
			isAtChatProject={!controller.browsingExecutor && tree.isAtChatProject}
			{selectedPath}
			store={tree}
			onFileSelect={handleFileSelect}
			onImageSelect={handleFileSelect}
		/>
	</div>
</div>
