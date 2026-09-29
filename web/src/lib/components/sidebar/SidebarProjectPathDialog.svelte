<script lang="ts">
	import { onDestroy, untrack } from 'svelte';
	import { getExecutors } from '$lib/context';
	import * as Dialog from '$lib/components/ui/dialog';
	import { Button } from '$lib/components/ui/button';
	import ProjectPathField from '$lib/components/chat/ProjectPathField.svelte';
	import ProjectPinnedPathList from '$lib/components/chat/ProjectPinnedPathList.svelte';
	import GitWorktreePickerModal from '$lib/components/git/GitWorktreePickerModal.svelte';
	import { ProjectPathDialogState } from '$lib/chat/project-paths/project-path-dialog-state.svelte.js';
	import { isPinnedProjectPath } from '$lib/chat/project-paths/project-pinned-paths.js';
	import type { ChatProjectPathDialog } from '$lib/components/chat/chat-action-dialogs-state.svelte.js';
	import Loader2 from '@lucide/svelte/icons/loader-2';
	import * as m from '$lib/paraglide/messages.js';

	interface SidebarProjectPathDialogProps {
		projectPathDialog: ChatProjectPathDialog | null;
		projectBasePath: string;
		pinnedProjectPaths?: string[];
		isMobile: boolean;
		onClose: () => void;
		onConfirm: (target: ChatProjectPathDialog, projectPath: string) => Promise<void> | void;
		onTogglePinnedProjectPath?: (path: string) => void | Promise<void>;
	}

	let {
		projectPathDialog,
		projectBasePath,
		pinnedProjectPaths = [],
		isMobile,
		onClose,
		onConfirm,
		onTogglePinnedProjectPath,
	}: SidebarProjectPathDialogProps = $props();

	const executors = getExecutors();
	const projectPathDialogState = new ProjectPathDialogState(executors);
	const filesAvailable = $derived(executors.filesAvailable(projectPathDialogState.executorId));
	let activeDialogKey = $state('');
	let pathInputRef = $state<HTMLInputElement | null>(null);
	let isUpdatingPinnedProjectPath = $state(false);

	let isOpen = $derived(projectPathDialog !== null);
	const pathContextKey = $derived(executors.pathContextKey(projectPathDialogState.executorId));
	let activeProjectBasePath = $derived(
		projectPathDialogState.executorId === 'local'
			? projectBasePath || '/'
			: (executors.get(projectPathDialogState.executorId)?.projectBasePath ?? ''),
	);
	let validationMessage = $derived(
		projectPathDialogState.submitError ?? projectPathDialogState.validationError,
	);
	let isPathInvalid = $derived(Boolean(validationMessage));
	let isCandidatePinned = $derived(
		isPinnedProjectPath(pinnedProjectPaths, projectPathDialogState.trimmedPath),
	);
	let canTogglePinnedProjectPath = $derived(
		Boolean(projectPathDialogState.trimmedPath) &&
			Boolean(onTogglePinnedProjectPath) &&
			!projectPathDialogState.isSubmitting &&
			!isUpdatingPinnedProjectPath,
	);
	let canOpenWorktreePicker = $derived(
		projectPathDialogState.canSelectWorktree && !isUpdatingPinnedProjectPath,
	);
	const showWorktreeLink = $derived(
		projectPathDialogState.gitAvailable &&
			projectPathDialogState.gitRepoStatus === 'git' &&
			projectPathDialogState.validationStatus === 'valid',
	);

	$effect(() => {
		if (!projectPathDialog) {
			activeDialogKey = '';
			projectPathDialogState.close();
			return;
		}

		const nextDialogKey = JSON.stringify([
			projectPathDialog.chatId,
			projectPathDialog.executorId,
			projectPathDialog.agentOwnershipEpoch,
			projectPathDialog.status,
			projectPathDialog.currentProjectPath,
		]);
		if (activeDialogKey === nextDialogKey) return;

		activeDialogKey = nextDialogKey;
		projectPathDialogState.open(projectPathDialog.currentProjectPath, projectPathDialog.executorId);
	});

	$effect(() => {
		if (!activeDialogKey) return;
		void projectPathDialogState.trimmedPath;
		const contextKey = pathContextKey;
		untrack(() => projectPathDialogState.scheduleValidation(contextKey));
	});

	onDestroy(() => {
		projectPathDialogState.dispose();
	});

	function handleOpenChange(open: boolean): void {
		if (!open && !projectPathDialogState.isSubmitting) onClose();
	}

	function handleOpenAutoFocus(event: Event): void {
		event.preventDefault();
		queueMicrotask(() => pathInputRef?.focus());
	}

	function handlePathKeydown(event: KeyboardEvent): void {
		if (event.key !== 'Enter') return;
		event.preventDefault();
		void submitProjectPath();
	}

	function selectPinnedProjectPath(path: string): void {
		if (projectPathDialogState.isSubmitting || isUpdatingPinnedProjectPath) return;
		projectPathDialogState.setCandidatePath(path);
		projectPathDialogState.showBrowser = false;
	}

	async function togglePinnedProjectPath(): Promise<void> {
		const path = projectPathDialogState.trimmedPath;
		if (!path || !onTogglePinnedProjectPath || isUpdatingPinnedProjectPath) return;
		isUpdatingPinnedProjectPath = true;
		try {
			await onTogglePinnedProjectPath(path);
		} catch (error) {
			console.warn('[SidebarProjectPathDialog] Failed to update pinned project paths', error);
		} finally {
			isUpdatingPinnedProjectPath = false;
		}
	}

	async function submitProjectPath(): Promise<void> {
		if (!projectPathDialog || !projectPathDialogState.canSubmit) return;

		projectPathDialogState.isSubmitting = true;
		projectPathDialogState.submitError = null;
		try {
			await onConfirm(projectPathDialog, projectPathDialogState.trimmedPath);
			onClose();
		} catch (error) {
			projectPathDialogState.setSubmitFailure(error);
		} finally {
			projectPathDialogState.isSubmitting = false;
		}
	}
</script>

{#if isOpen && projectPathDialogState.worktreePickerOpen}
	<GitWorktreePickerModal
		worktrees={projectPathDialogState.worktrees}
		isLoading={projectPathDialogState.isLoadingWorktrees}
		isCreating={projectPathDialogState.isCreatingWorktree}
		errorMessage={projectPathDialogState.worktreeError}
		onSelect={(path) => projectPathDialogState.selectWorktree(path)}
		onCreate={(path, branch, baseRef) =>
			projectPathDialogState.createWorktree(path, branch, baseRef)}
		onRefresh={() => {
			void projectPathDialogState.loadWorktrees();
		}}
		onClose={() => projectPathDialogState.closeWorktreePicker()}
	/>
{:else}
	<Dialog.Root open={isOpen} onOpenChange={handleOpenChange}>
		<Dialog.Content
			class="h-dvh w-full max-w-full overflow-hidden rounded-none border-0 p-0 sm:h-auto sm:max-w-lg sm:rounded-lg sm:border"
			onOpenAutoFocus={handleOpenAutoFocus}
		>
			<div class="flex h-full min-w-0 max-w-full flex-col sm:h-auto">
				<Dialog.Header class="min-w-0 max-w-full overflow-hidden border-b border-border px-5 py-4">
					<Dialog.Title>{m.sidebar_project_path_title()}</Dialog.Title>
					<Dialog.Description class="block w-full min-w-0 max-w-full truncate">
						{projectPathDialog?.chatTitle || m.sidebar_chats_unnamed()}
					</Dialog.Description>
				</Dialog.Header>

				<div class="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4">
					<div class="space-y-1.5">
						<span class="text-sm font-medium text-muted-foreground">
							{m.sidebar_project_path_current_label()}
						</span>
						<div
							class="min-h-9 rounded-md border border-border bg-muted/40 px-3 py-2 font-mono text-xs text-foreground"
						>
							<span class="block truncate">{projectPathDialog?.currentProjectPath ?? ''}</span>
						</div>
					</div>
					<p class="text-sm text-muted-foreground">
						{m.sidebar_project_path_queue_warning()}
					</p>

					<div class="space-y-1.5">
						<label
							for="sidebar-project-path-input"
							class="block text-sm font-medium text-muted-foreground"
						>
							{m.sidebar_project_path_new_label()}
						</label>
						<ProjectPathField
							id="sidebar-project-path-input"
							bind:ref={pathInputRef}
							bind:value={projectPathDialogState.candidatePath}
							placeholder={activeProjectBasePath}
							disabled={projectPathDialogState.isSubmitting}
							readonly={isUpdatingPinnedProjectPath}
							aria-invalid={isPathInvalid}
							aria-describedby="sidebar-project-path-feedback"
							oninput={() => (projectPathDialogState.submitError = null)}
							onkeydown={handlePathKeydown}
							class="h-9 font-mono sm:pointer-fine:text-xs"
							validationStatus={projectPathDialogState.validationStatus}
							validationError={projectPathDialogState.validationError}
							pin={{
								isPinned: isCandidatePinned,
								disabled: !canTogglePinnedProjectPath,
								loading: isUpdatingPinnedProjectPath,
								onToggle: togglePinnedProjectPath,
							}}
							browser={{
								open:
									filesAvailable &&
									projectPathDialogState.showBrowser &&
									!isUpdatingPinnedProjectPath,
								executorId: projectPathDialogState.executorId,
								executorContextKey: pathContextKey,
								currentPath: projectPathDialogState.trimmedPath || activeProjectBasePath,
								basePath: activeProjectBasePath,
								isMobile,
								onSelect: (path) => {
									if (isUpdatingPinnedProjectPath) return;
									projectPathDialogState.setCandidatePath(path);
								},
								onClose: () => (projectPathDialogState.showBrowser = false),
								button: {
									label: m.sidebar_project_path_browse(),
									disabled:
										!filesAvailable ||
										projectPathDialogState.isSubmitting ||
										isUpdatingPinnedProjectPath,
									onclick: () => (projectPathDialogState.showBrowser = true),
								},
							}}
							feedback={{
								worktree: showWorktreeLink
									? {
											disabled: !canOpenWorktreePicker,
											onOpen: () => projectPathDialogState.openWorktreePicker(),
										}
									: undefined,
							}}
						/>
					</div>

					<ProjectPinnedPathList
						{pinnedProjectPaths}
						selectedPath={projectPathDialogState.candidatePath}
						disabled={projectPathDialogState.isSubmitting || isUpdatingPinnedProjectPath}
						onSelect={selectPinnedProjectPath}
					/>

					<div id="sidebar-project-path-feedback" class="min-h-5">
						{#if validationMessage}
							<p class="text-xs text-destructive">{validationMessage}</p>
						{:else if projectPathDialogState.isUnchanged}
							<p class="text-xs text-muted-foreground">{m.sidebar_project_path_unchanged()}</p>
						{/if}
					</div>
				</div>

				<div class="flex justify-end gap-2 border-t border-border px-5 py-3">
					<Button
						variant="outline"
						onclick={onClose}
						disabled={projectPathDialogState.isSubmitting}
					>
						{m.sidebar_actions_cancel()}
					</Button>
					<Button
						onclick={() => {
							void submitProjectPath();
						}}
						disabled={!projectPathDialogState.canSubmit}
					>
						{#if projectPathDialogState.isSubmitting}
							<Loader2 class="mr-2 h-4 w-4 animate-spin" />
						{/if}
						{m.sidebar_project_path_update_button()}
					</Button>
				</div>
			</div>
		</Dialog.Content>
	</Dialog.Root>
{/if}
