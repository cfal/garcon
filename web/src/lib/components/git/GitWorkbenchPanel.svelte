<script lang="ts">
	import { untrack } from 'svelte';
	import AlertTriangle from '@lucide/svelte/icons/triangle-alert';
	import X from '@lucide/svelte/icons/x';
	import type { GitWorkbenchSurfaceController } from '$lib/git/workbench/git-workbench-surface.svelte.js';
	import type { ChatDraftAppend } from '$lib/chat/composer/chat-draft-append.js';
	import { gitProjectInvalidations } from '$lib/git/surface/git-project-invalidation.svelte.js';
	import { resolveGitEditorRoot } from '$lib/git/surface/git-editor-root.js';
	import {
		getFileSessions,
		getLocalSettings,
		getNotifications,
		getWorkspaceCoordinator,
	} from '$lib/context';
	import { startGitFreshnessPolling } from './git-freshness-polling';
	import GitConfirmModal from './GitConfirmModal.svelte';
	import GitFreshnessBanner from './GitFreshnessBanner.svelte';
	import GitPushModal from './GitPushModal.svelte';
	import GitWorkbench from './GitWorkbench.svelte';
	import GitWorkbenchToolbar from './GitWorkbenchToolbar.svelte';
	import * as m from '$lib/paraglide/messages.js';
	import type { WorkspaceWindowId } from '$lib/workspace/surface-types.js';
	import { openCommitFromGitWorkbench } from '$lib/git/workbench/git-workbench-navigation.js';

	let {
		controller,
		presentation,
		visible = true,
		onAppendToChatDraft,
	}: {
		controller: GitWorkbenchSurfaceController;
		presentation: WorkspaceWindowId | 'mobile';
		visible?: boolean;
		onAppendToChatDraft?: ChatDraftAppend;
	} = $props();

	const workspace = getWorkspaceCoordinator();
	const notifications = getNotifications();
	const fileSessions = getFileSessions();
	const localSettings = getLocalSettings();
	const wb = $derived(controller.workbench);
	const repository = $derived(controller.repository);
	const presentationVisible = $derived(
		visible && controller.presentationVisible && !controller.target.projectIdentityPending,
	);
	const activeProjectPath = $derived(controller.target.activeProjectPath);
	const activeTarget = $derived(controller.target.activeTarget ?? controller.target.fallbackTarget);
	const diffFontSize = $derived(Number.parseInt(localSettings.gitDiffFontSize, 10) || 12);

	$effect(() => {
		if (!presentationVisible || !activeProjectPath) return;
		return startGitFreshnessPolling({
			projectPath: activeProjectPath,
			checkFreshness: (projectPath) => {
				untrack(() => void wb.checkFreshness(projectPath));
			},
		});
	});

	$effect(() => {
		if (!presentationVisible) return;
		const key = controller.target.effectiveProjectKey;
		if (!key) return;
		const version = gitProjectInvalidations.version(key);
		untrack(() => void controller.refreshForInvalidation(key, version));
	});

	async function refresh(): Promise<void> {
		if (!activeProjectPath) return;
		await controller.target.refreshTargets();
		repository.refreshDeferredMetadata(activeProjectPath);
		await wb.refresh({ reason: 'manual' });
	}

	async function refreshStale(): Promise<void> {
		if (!activeProjectPath) return;
		repository.refreshDeferredMetadata(activeProjectPath);
		await wb.refreshStaleWorkbench();
		await controller.target.refreshTargets();
	}

	async function runMutation<T>(action: (projectPath: string) => Promise<T>): Promise<T | null> {
		const projectPath = activeProjectPath;
		if (!projectPath || !wb.ensureFreshForGitMutation()) return null;
		return wb.runLocalGitMutation(projectPath, () => action(projectPath));
	}

	function openCommit(): void {
		const opening = openCommitFromGitWorkbench(workspace, presentation);
		void opening.catch((error) => {
			notifications.error(error instanceof Error ? error.message : m.workspace_open_failed());
		});
	}

	async function openPush(): Promise<void> {
		const projectPath = activeProjectPath;
		if (!projectPath || !(await repository.prepareToolbarPush(projectPath))) return;
		if (projectPath === activeProjectPath) repository.showPushModal = true;
	}

	function openInEditor(relativePath: string, line: number): void {
		const projectPath = activeProjectPath;
		if (!projectPath) return;
		void fileSessions.open({
			fileRootPath: resolveGitEditorRoot({
				activeProjectPath: projectPath,
				targetRepoRoot: activeTarget?.repoRoot,
			}),
			relativePath,
			mode: 'code',
			origin: presentation,
			reason: 'user-open',
			line,
		});
	}
</script>

{#if !activeProjectPath}
	<div class="grid h-full place-items-center text-muted-foreground">
		<p>{m.git_panel_select_project()}</p>
	</div>
{:else}
	<div class="relative flex h-full min-h-0 flex-col bg-background">
		<GitWorkbenchToolbar
			{controller}
			{presentation}
			onCommit={openCommit}
			onPush={() => void openPush()}
			onRefresh={() => void refresh()}
		/>

		{#if controller.target.lastError || repository.lastError || wb.lastError}
			<div
				class="flex items-center gap-2 border-b border-status-error-border bg-status-error/10 px-3 py-1.5 text-xs text-status-error-foreground"
			>
				<AlertTriangle class="h-3.5 w-3.5 shrink-0" />
				<span class="min-w-0 flex-1 truncate">
					{controller.target.lastError ?? repository.lastError ?? wb.lastError}
				</span>
				<button
					type="button"
					class="rounded p-0.5 hover:bg-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-interactive-accent"
					aria-label={m.git_action_dismiss_error()}
					onclick={() => {
						controller.target.dismissError();
						repository.dismissError();
						wb.dismissError();
					}}
				>
					<X class="h-3.5 w-3.5" />
				</button>
			</div>
		{/if}

		{#if wb.isExternallyStale}
			<GitFreshnessBanner
				isRefreshing={wb.files.isLoadingTree}
				onRefresh={() => void refreshStale()}
			/>
		{/if}

		<GitWorkbench
			target={activeTarget}
			{presentation}
			active={presentationVisible}
			{wb}
			{onAppendToChatDraft}
			onOpenChat={() => void workspace.focusChat()}
			{diffFontSize}
			onOpenInEditor={openInEditor}
		/>

		{#if repository.confirmAction}
			<GitConfirmModal
				confirmAction={repository.confirmAction}
				onConfirm={() =>
					void runMutation(async (projectPath) => {
						const ok = await repository.confirmAndExecute(projectPath);
						if (ok) await wb.refresh({ reason: 'git-action' });
						return ok;
					})}
				onCancel={() => (repository.confirmAction = null)}
			/>
		{/if}

		{#if repository.showPushModal}
			<GitPushModal
				remotes={repository.pushRemotes}
				currentBranch={repository.currentBranch}
				isPushing={repository.isPushing}
				onPush={(remote) =>
					void runMutation(async (projectPath) => {
						const ok = await repository.handlePush(projectPath, remote);
						if (ok) await wb.refresh({ reason: 'git-action' });
						return ok;
					})}
				onClose={() => (repository.showPushModal = false)}
			/>
		{/if}
	</div>
{/if}
