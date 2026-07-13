<script module lang="ts">
	let terminalSurface: ReturnType<typeof loadTerminalSurface> | null = null;
	let terminalLauncherSurface: ReturnType<typeof loadTerminalLauncherSurface> | null = null;
	let fileSurface: ReturnType<typeof loadFileSurface> | null = null;
	let filesSurface: ReturnType<typeof loadFilesSurface> | null = null;
	let gitSurface: ReturnType<typeof loadGitSurface> | null = null;
	let pullRequestsSurface: ReturnType<typeof loadPullRequestsSurface> | null = null;
	let quickGitSurface: ReturnType<typeof loadQuickGitSurface> | null = null;

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

	function loadQuickGitSurface() {
		return import('$lib/components/git/QuickGitSurface.svelte').then((module) => module.default);
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

	function quickGitRenderer() {
		return (quickGitSurface ??= loadQuickGitSurface().catch((error) => {
			quickGitSurface = null;
			throw error;
		}));
	}
</script>

<script lang="ts">
	import {
		getFileSessions,
		getGhCapability,
		getQuickGit,
		getWorkspaceContext,
		getWorkspaceCoordinator,
	} from '$lib/context';
	import type { HostId, SurfaceDescriptor } from '$lib/workspace/surface-types.js';
	import * as m from '$lib/paraglide/messages.js';
	import {
		setSurfaceFrameBridge,
		type SurfaceFrameBridge,
	} from '$lib/workspace/surface-frame-context.js';

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
	const quickGit = getQuickGit();
	const files = getFileSessions();
	const current = $derived(workspaceContext.current);
	let activated = $state(false);

	$effect(() => {
		if (visible) activated = true;
	});
</script>

{#if activated}
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
					{m.workspace_file_session_unavailable()}
				</div>
			{/if}
		{:else if surface.type === 'singleton' && surface.kind === 'files'}
			{#await filesRenderer() then FilesPanel}
				<FilesPanel
					projectPath={current?.projectPath ?? null}
					chatId={current?.chatId ?? null}
					effectiveProjectKey={current?.effectiveProjectKey ?? null}
					isVisible={visible}
				/>
			{/await}
		{:else if surface.type === 'singleton' && surface.kind === 'git'}
			{#await gitRenderer() then GitPanel}
				<GitPanel
					chatId={current?.chatId ?? null}
					projectPath={current?.projectPath ?? null}
					effectiveProjectKey={current?.effectiveProjectKey ?? null}
					isMobile={presentation === 'mobile'}
					isVisible={visible}
					{onSendToChat}
				/>
			{/await}
		{:else if surface.type === 'singleton' && surface.kind === 'pull-requests'}
			{#if current && ghCapability.available}
				{#await pullRequestsRenderer() then PullRequestsPanel}
					<PullRequestsPanel
						projectPath={current.projectPath}
						effectiveProjectKey={current.effectiveProjectKey ?? current.projectPath}
						isMobile={presentation === 'mobile'}
						isVisible={visible}
						{onSendToChat}
						onNavigateToChat={() => void workspace.focusChat()}
					/>
				{/await}
			{:else if visible && !ghCapability.hasChecked}
				<div class="grid h-full place-items-center px-6 text-center text-sm text-muted-foreground">
					{m.workspace_pull_requests_checking()}
				</div>
			{:else if visible}
				<div class="grid h-full place-items-center px-6 text-center text-sm text-muted-foreground">
					<div class="max-w-sm">
						<p>{m.workspace_pull_requests_unavailable()}</p>
						{#if ghCapability.hasChecked}
							<button
								class="mt-3 rounded-md border border-border px-3 py-1.5 text-xs hover:bg-accent"
								onclick={() => void ghCapability.refresh()}>{m.common_retry()}</button
							>
						{/if}
					</div>
				</div>
			{/if}
		{:else if surface.type === 'singleton' && surface.kind === 'quick-git'}
			{#await quickGitRenderer() then QuickGitSurface}
				<QuickGitSurface
					controller={quickGit}
					{presentation}
					onOpenFullGit={() =>
						void (workspace.isMobile
							? workspace.focusMobileSingleton('git')
							: workspace.openSingleton('git', 'main'))}
				/>
			{/await}
		{/if}

		{#snippet failed(error, reset)}
			<div class="grid h-full place-items-center px-6 text-center">
				<div class="max-w-sm text-sm text-status-error-foreground">
					<p>{error instanceof Error ? error.message : m.workspace_surface_render_failed()}</p>
					<button
						type="button"
						class="mt-3 rounded-md border border-border px-3 py-1.5 text-xs text-foreground hover:bg-accent"
						onclick={reset}>{m.common_retry()}</button
					>
				</div>
			</div>
		{/snippet}
	</svelte:boundary>
{/if}
