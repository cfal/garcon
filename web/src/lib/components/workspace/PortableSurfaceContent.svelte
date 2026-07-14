<script module lang="ts">
	let terminalSurface: ReturnType<typeof loadTerminalSurface> | null = null;
	let terminalLauncherSurface: ReturnType<typeof loadTerminalLauncherSurface> | null = null;
	let fileSurface: ReturnType<typeof loadFileSurface> | null = null;
	let filesSurface: ReturnType<typeof loadFilesSurface> | null = null;
	let gitSurface: ReturnType<typeof loadGitSurface> | null = null;
	let pullRequestsSurface: ReturnType<typeof loadPullRequestsSurface> | null = null;
	let commitSurface: ReturnType<typeof loadCommitSurface> | null = null;

	function loadTerminalSurface() {
		return import('$lib/components/terminal/TerminalSurface.svelte').then(
			(module) => module.default,
		);
	}

	function loadTerminalLauncherSurface() {
		return import('$lib/components/terminal/TerminalLauncherSurface.svelte').then(
			(module) => module.default,
		);
	}

	function loadFileSurface() {
		return import('$lib/components/files/FileSurface.svelte').then((module) => module.default);
	}

	function loadFilesSurface() {
		return import('$lib/components/files/FilesPanel.svelte').then((module) => module.default);
	}

	function loadGitSurface() {
		return import('$lib/components/git/GitPanel.svelte').then((module) => module.default);
	}

	function loadPullRequestsSurface() {
		return import('$lib/components/pr/PullRequestsPanel.svelte').then((module) => module.default);
	}

	function loadCommitSurface() {
		return import('$lib/components/git/CommitSurface.svelte').then((module) => module.default);
	}

	function terminalRenderer() {
		return (terminalSurface ??= loadTerminalSurface().catch((error) => {
			terminalSurface = null;
			throw error;
		}));
	}

	function terminalLauncherRenderer() {
		return (terminalLauncherSurface ??= loadTerminalLauncherSurface().catch((error) => {
			terminalLauncherSurface = null;
			throw error;
		}));
	}

	function fileRenderer() {
		return (fileSurface ??= loadFileSurface().catch((error) => {
			fileSurface = null;
			throw error;
		}));
	}

	function filesRenderer() {
		return (filesSurface ??= loadFilesSurface().catch((error) => {
			filesSurface = null;
			throw error;
		}));
	}

	function gitRenderer() {
		return (gitSurface ??= loadGitSurface().catch((error) => {
			gitSurface = null;
			throw error;
		}));
	}

	function pullRequestsRenderer() {
		return (pullRequestsSurface ??= loadPullRequestsSurface().catch((error) => {
			pullRequestsSurface = null;
			throw error;
		}));
	}

	function commitRenderer() {
		return (commitSurface ??= loadCommitSurface().catch((error) => {
			commitSurface = null;
			throw error;
		}));
	}
</script>

<script lang="ts">
	import {
		getFileSessions,
		getGhCapability,
		getSingletonSurfaces,
		getWorkspaceContext,
		getWorkspaceCoordinator,
	} from '$lib/context';
	import type { HostId, SurfaceDescriptor } from '$lib/workspace/surface-types.js';
	import * as m from '$lib/paraglide/messages.js';
	import {
		setSurfaceFrameBridge,
		type SurfaceFrameBridge,
	} from '$lib/workspace/surface-frame-context.js';
	import X from '@lucide/svelte/icons/x';
	import ProjectSurfaceGate from './ProjectSurfaceGate.svelte';

	let {
		surface,
		presentation,
		visible,
		onSendToChat,
		frameBridge,
	}: {
		surface: SurfaceDescriptor;
		presentation: HostId | 'mobile';
		visible: boolean;
		onSendToChat: (message: string) => Promise<boolean>;
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
			<TerminalLauncherSurface host={presentation === 'mobile' ? 'main' : presentation} />
		{/await}
	{:else if surface.type === 'file'}
		{@const session = files.get(surface.fileSessionId)}
		{#if session}
			{#await fileRenderer() then FileSurface}
				<FileSurface {session} {presentation} />
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
				<FilesPanel {projectState} />
			{/await}
		</ProjectSurfaceGate>
	{:else if surface.type === 'singleton' && surface.kind === 'git'}
		{@const controller = singletonSurfaces.git()}
		{@const projectPath =
			projectState.kind === 'available'
				? projectState.project.projectPath
				: projectState.kind === 'resolving'
					? controller.baseProjectPath
					: null}
		{@const effectiveProjectKey =
			projectState.kind === 'available'
				? projectState.project.effectiveProjectKey
				: projectState.kind === 'resolving'
					? controller.effectiveProjectKey
					: null}
		<ProjectSurfaceGate
			{projectState}
			retainedProjectPath={controller.baseProjectPath}
			retainedEffectiveProjectKey={controller.effectiveProjectKey}
		>
			{#await gitRenderer() then GitPanel}
				<GitPanel
					{projectPath}
					{effectiveProjectKey}
					isMobile={presentation === 'mobile'}
					{presentation}
					isVisible={visible}
					{onSendToChat}
				/>
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
			retainedProjectPath={controller.projectPath}
			retainedEffectiveProjectKey={controller.effectiveProjectKey}
		>
			{#await commitRenderer() then CommitSurface}
				<CommitSurface {controller} {presentation} />
			{/await}
		</ProjectSurfaceGate>
	{/if}

	{#snippet failed(error, reset)}
		<div class="grid h-full place-items-center px-6 text-center">
			<div class="max-w-sm text-sm text-status-error-foreground">
				<p>{error instanceof Error ? error.message : m.workspace_surface_render_failed()}</p>
				<div class="mt-3 flex items-center justify-center gap-2">
					<button
						type="button"
						class="rounded-md border border-border px-3 py-1.5 text-xs text-foreground hover:bg-accent"
						onclick={reset}>{m.common_retry()}</button
					>
					<button
						type="button"
						class="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs text-foreground hover:bg-accent"
						onclick={() => void workspace.closeSurface(surface.id)}
					>
						<X class="h-3.5 w-3.5" />
						{m.workspace_close_view()}
					</button>
				</div>
			</div>
		</div>
	{/snippet}
</svelte:boundary>
