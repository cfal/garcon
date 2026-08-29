<script module lang="ts">
	import { lazyRenderer } from '$lib/utils/lazy-renderer.js';

	const terminalRenderer = lazyRenderer(
		() => import('$lib/components/terminal/TerminalSurface.svelte'),
	);
	const terminalLauncherRenderer = lazyRenderer(
		() => import('$lib/components/terminal/TerminalLauncherSurface.svelte'),
	);
	const fileRenderer = lazyRenderer(() => import('$lib/components/files/FileSurface.svelte'));
	const filesRenderer = lazyRenderer(() => import('$lib/components/files/FilesPanel.svelte'));
	const gitWorkbenchRenderer = lazyRenderer(
		() => import('$lib/components/git/GitWorkbenchPanel.svelte'),
	);
	const gitHistoryRenderer = lazyRenderer(
		() => import('$lib/components/git/GitHistoryPanel.svelte'),
	);
	const gitCompareRenderer = lazyRenderer(
		() => import('$lib/components/git/GitComparePanel.svelte'),
	);
	const pullRequestsRenderer = lazyRenderer(
		() => import('$lib/components/pr/PullRequestsPanel.svelte'),
	);
	const commitRenderer = lazyRenderer(() => import('$lib/components/git/CommitSurface.svelte'));
</script>

<script lang="ts">
	import {
		getFileSessions,
		getGhCapability,
		getSingletonSurfaces,
		getWorkspaceContext,
		getWorkspaceCoordinator,
	} from '$lib/context';
	import type { WorkspaceWindowId, SurfaceDescriptor } from '$lib/workspace/surface-types.js';
	import * as m from '$lib/paraglide/messages.js';
	import {
		setSurfaceFrameBridge,
		type SurfaceFrameBridge,
	} from '$lib/workspace/surface-frame-context.js';
	import X from '@lucide/svelte/icons/x';
	import ProjectSurfaceGate from './ProjectSurfaceGate.svelte';
	import SurfaceErrorState from './SurfaceErrorState.svelte';
	import type { ChatDraftAppend } from '$lib/chat/composer/chat-draft-append.js';

	let {
		surface,
		presentation,
		visible,
		onSendToChat,
		onAppendToChatDraft,
		frameBridge,
	}: {
		surface: SurfaceDescriptor;
		presentation: WorkspaceWindowId | 'mobile';
		visible: boolean;
		onSendToChat: (message: string) => Promise<boolean>;
		onAppendToChatDraft: ChatDraftAppend;
		frameBridge: SurfaceFrameBridge;
	} = $props();
	setSurfaceFrameBridge(() => frameBridge);
	const workspace = getWorkspaceCoordinator();
	const workspaceContext = getWorkspaceContext();
	const ghCapability = getGhCapability();
	const singletonSurfaces = getSingletonSurfaces();
	const files = getFileSessions();
	const projectState = $derived(workspaceContext.projectState);
</script>

<svelte:boundary>
	{#if surface.type === 'terminal'}
		{#await terminalRenderer()}
			{#if visible}<div class="grid h-full place-items-center text-sm text-muted-foreground">
					{m.workspace_loading_terminal()}
				</div>{/if}
		{:then TerminalSurface}
			<TerminalSurface terminalId={surface.terminalId} host={presentation} {visible} />
		{/await}
	{:else if surface.type === 'terminal-launcher'}
		{#await terminalLauncherRenderer() then TerminalLauncherSurface}
			<TerminalLauncherSurface
				host={presentation === 'mobile' ? workspace.defaultWindowId : presentation}
			/>
		{/await}
	{:else if surface.type === 'file'}
		{@const session = files.get(surface.fileSessionId)}
		{#if session}
			{#await fileRenderer() then FileSurface}
				<FileSurface
					{session}
					{presentation}
					onClose={() => void workspace.closeSurface(surface.id)}
					closeDisabled={workspace.isSurfaceCloseBlocked(surface.id)}
				/>
			{/await}
		{:else if visible}
			<div class="grid h-full place-items-center text-sm text-muted-foreground">
				<div class="text-center">
					<p>{m.workspace_file_session_unavailable()}</p>
					<button
						type="button"
						class="mt-3 inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs text-foreground hover:bg-accent"
						onclick={() => void workspace.closeSurface(surface.id)}
					>
						<X class="h-3.5 w-3.5" />
						{m.workspace_close_view()}
					</button>
				</div>
			</div>
		{/if}
	{:else if surface.type === 'singleton' && surface.kind === 'files'}
		{@const controller = singletonSurfaces.files()}
		<ProjectSurfaceGate
			{projectState}
			retainedProjectPath={controller.tree.projectPath}
			retainedEffectiveProjectKey={controller.tree.effectiveProjectKey}
		>
			{#await filesRenderer() then FilesPanel}
				<FilesPanel {presentation} />
			{/await}
		</ProjectSurfaceGate>
	{:else if surface.type === 'singleton' && surface.kind === 'git'}
		{@const controller = singletonSurfaces.gitWorkbench()}
		<ProjectSurfaceGate
			{projectState}
			retainedProjectPath={controller.target.baseProjectPath}
			retainedEffectiveProjectKey={controller.target.effectiveProjectKey}
		>
			{#await gitWorkbenchRenderer() then GitWorkbenchPanel}
				<GitWorkbenchPanel {controller} {presentation} {visible} {onAppendToChatDraft} />
			{/await}
		</ProjectSurfaceGate>
	{:else if surface.type === 'singleton' && surface.kind === 'git-history'}
		{@const controller = singletonSurfaces.gitHistory()}
		<ProjectSurfaceGate
			{projectState}
			retainedProjectPath={controller.target.baseProjectPath}
			retainedEffectiveProjectKey={controller.target.effectiveProjectKey}
		>
			{#await gitHistoryRenderer() then GitHistoryPanel}
				<GitHistoryPanel {controller} {presentation} {visible} {onAppendToChatDraft} />
			{/await}
		</ProjectSurfaceGate>
	{:else if surface.type === 'singleton' && surface.kind === 'git-compare'}
		{@const controller = singletonSurfaces.gitCompare()}
		<ProjectSurfaceGate
			{projectState}
			retainedProjectPath={controller.target.baseProjectPath}
			retainedEffectiveProjectKey={controller.target.effectiveProjectKey}
		>
			{#await gitCompareRenderer() then GitComparePanel}
				<GitComparePanel {controller} {presentation} {visible} {onAppendToChatDraft} />
			{/await}
		</ProjectSurfaceGate>
	{:else if surface.type === 'singleton' && surface.kind === 'pull-requests'}
		{@const controller = singletonSurfaces.pullRequests()}
		<ProjectSurfaceGate
			{projectState}
			retainedProjectPath={controller.projectPath}
			retainedEffectiveProjectKey={controller.effectiveProjectKey}
		>
			{#await pullRequestsRenderer() then PullRequestsPanel}
				<PullRequestsPanel
					{controller}
					isMobile={presentation === 'mobile'}
					{onSendToChat}
					onNavigateToChat={() => void workspace.focusChat()}
					onRetryCapability={() => void ghCapability.refresh()}
				/>
			{/await}
		</ProjectSurfaceGate>
	{:else if surface.type === 'singleton' && surface.kind === 'commit'}
		{@const controller = singletonSurfaces.commit()}
		<ProjectSurfaceGate
			{projectState}
			retainedProjectPath={controller.target.baseProjectPath}
			retainedEffectiveProjectKey={controller.target.effectiveProjectKey}
		>
			{#await commitRenderer() then CommitSurface}
				<CommitSurface {controller} {presentation} />
			{/await}
		</ProjectSurfaceGate>
	{/if}

	{#snippet failed(error, reset)}
		<SurfaceErrorState
			message={error instanceof Error ? error.message : m.workspace_surface_render_failed()}
			onRetry={reset}
			onClose={() => void workspace.closeSurface(surface.id)}
			closeDisabled={workspace.isSurfaceCloseBlocked(surface.id)}
		/>
	{/snippet}
</svelte:boundary>
