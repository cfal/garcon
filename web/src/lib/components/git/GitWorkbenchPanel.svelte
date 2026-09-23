<script lang="ts">
	import { untrack } from 'svelte';
	import type { GitProjectTarget } from '$lib/api/git-client.js';
	import { sameGitProject } from '$lib/git/targets/git-target.js';
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
		getSingletonSurfaces,
	} from '$lib/context';
	import { startGitFreshnessPolling } from './git-freshness-polling';
	import GitConfirmModal from './GitConfirmModal.svelte';
	import GitFreshnessBanner from './GitFreshnessBanner.svelte';
	import GitPushModal from './GitPushModal.svelte';
	import GitWorkbench from './GitWorkbench.svelte';
	import GitWorkbenchToolbar from './GitWorkbenchToolbar.svelte';
	import GitProjectContent from './GitProjectContent.svelte';
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
	const surfaces = getSingletonSurfaces();
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
		const target = activeTarget;
		if (!presentationVisible || !target) return;
		return startGitFreshnessPolling({
			projectPath: target.projectPath,
			checkFreshness: () => {
				untrack(() => void wb.checkFreshness(target));
			},
		});
	});

	$effect(() => {
		if (!presentationVisible) return;
		const key = controller.target.effectiveProjectKey;
		if (!key) return;
		const version = gitProjectInvalidations.version(controller.target.nodeId, key);
		untrack(() => void controller.refreshForInvalidation(key, version));
	});

	async function refresh(): Promise<void> {
		const target = activeTarget;
		if (!target || !controller.target.canChangeTarget) return;
		await controller.target.refreshTargets();
		if (!sameGitProject(target, activeTarget)) return;
		repository.refreshDeferredMetadata(target);
		await wb.refresh({ reason: 'manual' });
	}

	async function refreshStale(): Promise<void> {
		const target = activeTarget;
		if (!target) return;
		repository.refreshDeferredMetadata(target);
		await wb.refreshStaleWorkbench();
		if (!sameGitProject(target, activeTarget)) return;
		await controller.target.refreshTargets();
	}

	async function runMutation<T>(
		action: (project: GitProjectTarget) => Promise<T>,
	): Promise<T | null> {
		const target = activeTarget;
		if (!target || !wb.ensureFreshForGitMutation()) return null;
		try {
			return await wb.runLocalGitMutation(target, () => action(target));
		} catch {
			// The coordinator publishes failures for the captured target, even after disconnection.
			return null;
		}
	}

	function openCommit(): void {
		const target = controller.target.requestTarget;
		if (!target || !controller.target.canChangeTarget) return;
		if (!surfaces.commit().target.selectProject(target)) return;
		const opening = openCommitFromGitWorkbench(workspace, presentation);
		void opening.catch((error) => {
			notifications.error(error instanceof Error ? error.message : m.workspace_open_failed());
		});
	}

	async function openPush(): Promise<void> {
		const target = activeTarget;
		if (!target || !controller.target.canChangeTarget) return;
		if (!(await repository.prepareToolbarPush(target))) return;
		if (sameGitProject(target, activeTarget)) repository.showPushModal = true;
	}

	function openInEditor(relativePath: string, line: number): void {
		const projectPath = activeProjectPath;
		if (!projectPath || !activeTarget) return;
		void fileSessions.open({
			nodeId: activeTarget.nodeId,
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

<div class="relative flex h-full min-h-0 flex-col bg-background">
	<GitWorkbenchToolbar
		{controller}
		{presentation}
		onCommit={openCommit}
		onPush={() => void openPush()}
		onRefresh={() => void refresh()}
	/>
	<GitProjectContent
		selection={controller.target.projectSelection}
		ready={!controller.target.projectIdentityPending &&
			controller.target.identity === controller.target.appliedIdentity}
	>
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
	</GitProjectContent>
</div>
