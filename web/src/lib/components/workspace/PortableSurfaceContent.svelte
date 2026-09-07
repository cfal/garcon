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
	const chatMapRenderer = lazyRenderer(
		() => import('$lib/components/chat-map/ChatMapPanel.svelte'),
	);
</script>

<script lang="ts">
	import {
		getChatSessions,
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
		onChooseProjectFolder,
		frameBridge,
	}: {
		surface: SurfaceDescriptor;
		presentation: WorkspaceWindowId | 'mobile';
		visible: boolean;
		onSendToChat: (message: string) => Promise<boolean>;
		onAppendToChatDraft: ChatDraftAppend;
		onChooseProjectFolder?: () => void;
		frameBridge: SurfaceFrameBridge;
	} = $props();
	setSurfaceFrameBridge(() => frameBridge);
	const workspace = getWorkspaceCoordinator();
	const workspaceContext = getWorkspaceContext();
	const ghCapability = getGhCapability();
	const singletonSurfaces = getSingletonSurfaces();
	const files = getFileSessions();
	const sessions = getChatSessions();
	const projectState = $derived(workspaceContext.projectState);
</script>

<svelte:boundary>
	{#if surface.type === 'terminal'}
		{#await terminalRenderer()}
			{#if visible}<div class="grid h-full place-items-center text-sm text-muted-foreground">
					{m.workspace_loading_terminal()}
				</div>{/if}
		{:then TerminalSurface}
			<TerminalSurface terminalId={surface.terminalId} host={presentation} />
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
			target={workspaceContext.currentTarget}
			retainedProjectPath={controller.tree.projectPath}
			retainedEffectiveProjectKey={controller.tree.effectiveProjectKey}
			onChooseFolder={onChooseProjectFolder}
		>
			{#await filesRenderer() then FilesPanel}
				<FilesPanel {presentation} />
			{/await}
		</ProjectSurfaceGate>
	{:else if surface.type === 'singleton' && surface.kind === 'git'}
		{@const controller = singletonSurfaces.gitWorkbench()}
		<ProjectSurfaceGate
			{projectState}
			target={workspaceContext.currentTarget}
			retainedProjectPath={controller.target.baseProjectPath}
			retainedEffectiveProjectKey={controller.target.effectiveProjectKey}
			onChooseFolder={onChooseProjectFolder}
		>
			{#await gitWorkbenchRenderer() then GitWorkbenchPanel}
				<GitWorkbenchPanel {controller} {presentation} {visible} {onAppendToChatDraft} />
			{/await}
		</ProjectSurfaceGate>
	{:else if surface.type === 'singleton' && surface.kind === 'git-history'}
		{@const controller = singletonSurfaces.gitHistory()}
		<ProjectSurfaceGate
			{projectState}
			target={workspaceContext.currentTarget}
			retainedProjectPath={controller.target.baseProjectPath}
			retainedEffectiveProjectKey={controller.target.effectiveProjectKey}
			onChooseFolder={onChooseProjectFolder}
		>
			{#await gitHistoryRenderer() then GitHistoryPanel}
				<GitHistoryPanel {controller} {presentation} {visible} {onAppendToChatDraft} />
			{/await}
		</ProjectSurfaceGate>
	{:else if surface.type === 'singleton' && surface.kind === 'git-compare'}
		{@const controller = singletonSurfaces.gitCompare()}
		<ProjectSurfaceGate
			{projectState}
			target={workspaceContext.currentTarget}
			retainedProjectPath={controller.target.baseProjectPath}
			retainedEffectiveProjectKey={controller.target.effectiveProjectKey}
			onChooseFolder={onChooseProjectFolder}
		>
			{#await gitCompareRenderer() then GitComparePanel}
				<GitComparePanel {controller} {presentation} {visible} {onAppendToChatDraft} />
			{/await}
		</ProjectSurfaceGate>
	{:else if surface.type === 'singleton' && surface.kind === 'pull-requests'}
		{@const controller = singletonSurfaces.pullRequests()}
		<ProjectSurfaceGate
			{projectState}
			target={workspaceContext.currentTarget}
			retainedProjectPath={controller.projectPath}
			retainedEffectiveProjectKey={controller.effectiveProjectKey}
			onChooseFolder={onChooseProjectFolder}
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
			target={workspaceContext.currentTarget}
			retainedProjectPath={controller.target.baseProjectPath}
			retainedEffectiveProjectKey={controller.target.effectiveProjectKey}
			onChooseFolder={onChooseProjectFolder}
		>
			{#await commitRenderer() then CommitSurface}
				<CommitSurface {controller} {presentation} />
			{/await}
		</ProjectSurfaceGate>
	{:else if surface.type === 'singleton' && surface.kind === 'chat-map'}
		{@const controller = singletonSurfaces.chatMap()}
		{#await chatMapRenderer() then ChatMapPanel}
			<ChatMapPanel
				{controller}
				chats={sessions.orderedChats}
				selectedChatId={sessions.selectedChatId}
				{visible}
				{presentation}
			/>
		{/await}
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
