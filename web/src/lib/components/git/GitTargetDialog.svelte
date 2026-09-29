<script lang="ts">
	// Selects the Git folder used by the Git panel. Worktree selection updates
	// only the pending path; the active target changes after OK.

	import { onDestroy, untrack } from 'svelte';
	import { getExecutors, getNotifications } from '$lib/context';
	import * as Dialog from '$lib/components/ui/dialog';
	import ProjectPathField from '$lib/components/chat/ProjectPathField.svelte';
	import ProjectPinnedPathList from '$lib/components/chat/ProjectPinnedPathList.svelte';
	import GitWorktreePickerModal from './GitWorktreePickerModal.svelte';
	import { GitTargetDialogState } from '$lib/git/targets/git-target-dialog.svelte.js';
	import { isPinnedProjectPath } from '$lib/chat/project-paths/project-pinned-paths.js';
	import type { GitTargetCandidate } from '$lib/api/git.js';
	import Folder from '@lucide/svelte/icons/folder';
	import X from '@lucide/svelte/icons/x';
	import Loader2 from '@lucide/svelte/icons/loader-2';
	import * as m from '$lib/paraglide/messages.js';

	interface GitTargetDialogProps {
		executorId: string;
		initialPath: string;
		projectBasePath: string;
		pinnedProjectPaths?: string[];
		isMobile: boolean;
		onConfirm: (target: GitTargetCandidate) => void | Promise<void>;
		onTogglePinnedProjectPath?: (path: string) => void | Promise<void>;
		onClose: () => void;
	}

	let {
		executorId,
		initialPath,
		projectBasePath,
		pinnedProjectPaths = [],
		isMobile,
		onConfirm,
		onTogglePinnedProjectPath,
		onClose,
	}: GitTargetDialogProps = $props();

	const executors = getExecutors();
	const notifications = getNotifications();
	const executorContextKey = $derived(executors.gitContextKey(executorId));
	const dialog = new GitTargetDialogState({
		onMutationError: (error, target) =>
			notifications.error(
				`${executors.label(target.executorId)}: ${target.projectPath}: ${error instanceof Error ? error.message : String(error)}`,
			),
		get executorId() {
			return executorId;
		},
		get executorContextKey() {
			return executorContextKey;
		},
		get available() {
			return executors.gitAvailable(executorId);
		},
		get initialPath() {
			return initialPath;
		},
	});
	let isUpdatingPinnedProjectPath = $state(false);
	const isCandidatePinned = $derived(isPinnedProjectPath(pinnedProjectPaths, dialog.trimmedPath));
	const canTogglePinnedProjectPath = $derived(
		Boolean(dialog.trimmedPath) &&
			Boolean(onTogglePinnedProjectPath) &&
			!isUpdatingPinnedProjectPath &&
			!dialog.isConfirming,
	);

	$effect(() => {
		void dialog.candidatePath;
		void executorContextKey;
		untrack(() => dialog.scheduleValidation());
	});

	onDestroy(() => {
		dialog.dispose();
	});

	async function confirmSelection(): Promise<void> {
		const target = await dialog.resolveConfirmedTarget();
		if (!target) return;
		try {
			await onConfirm(target);
			onClose();
		} catch (error) {
			dialog.validationStatus = 'invalid';
			dialog.validationError =
				error instanceof Error ? error.message : m.git_target_switch_failed();
		}
	}

	async function togglePinnedProjectPath(): Promise<void> {
		const path = dialog.trimmedPath;
		if (!path || !onTogglePinnedProjectPath || isUpdatingPinnedProjectPath) return;
		isUpdatingPinnedProjectPath = true;
		try {
			await onTogglePinnedProjectPath(path);
		} catch (error) {
			console.warn('[GitTargetDialog] Failed to update pinned project paths', error);
		} finally {
			isUpdatingPinnedProjectPath = false;
		}
	}
</script>

{#if dialog.worktreePickerOpen}
	<GitWorktreePickerModal
		worktrees={dialog.worktrees}
		isLoading={dialog.isLoadingWorktrees}
		isCreating={dialog.isCreatingWorktree}
		errorMessage={dialog.worktreeError}
		onSelect={(path) => dialog.selectWorktree(path)}
		onCreate={(path, branch, baseRef) => dialog.createWorktree(path, branch, baseRef)}
		onRefresh={() => dialog.loadWorktrees()}
		onClose={() => dialog.closeWorktreePicker()}
	/>
{:else}
	<Dialog.Root
		open={true}
		onOpenChange={(open) => {
			if (!open) onClose();
		}}
	>
		<Dialog.Content
			class="w-[calc(100%-2rem)] max-w-lg overflow-visible rounded-xl border border-border bg-popover p-0 shadow-2xl"
			showCloseButton={false}
			aria-label={m.git_target()}
		>
			<div class="flex flex-col">
				<div class="flex items-center gap-3 border-b border-border px-4 py-3">
					<Folder class="h-4 w-4 shrink-0 text-muted-foreground" />
					<h2 class="flex-1 text-sm font-medium text-foreground">{m.git_target()}</h2>
					<button
						type="button"
						onclick={onClose}
						class="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
						aria-label={m.share_dialog_close()}
					>
						<X class="h-3.5 w-3.5" />
					</button>
				</div>

				<div class="space-y-3 px-4 py-4">
					<div class="space-y-2">
						<label
							for="git-target-path-input"
							class="block text-sm font-medium text-muted-foreground"
						>
							{m.chat_new_chat_project_path()}
						</label>
						<ProjectPathField
							id="git-target-path-input"
							bind:value={dialog.candidatePath}
							readonly={isUpdatingPinnedProjectPath}
							placeholder={projectBasePath}
							validationStatus={dialog.validationStatus}
							validationError={dialog.validationError}
							onfocus={(event) => {
								if (!executors.filesAvailable(executorId)) return;
								if (isMobile) event.currentTarget.blur();
								if (isUpdatingPinnedProjectPath) return;
								dialog.showBrowser = true;
							}}
							oninput={() => {
								dialog.validationError = null;
								dialog.worktreeError = null;
							}}
							onkeydown={(event) => {
								if (event.key === 'Enter') {
									event.preventDefault();
									dialog.showBrowser = false;
									void confirmSelection();
								}
							}}
							pin={{
								isPinned: isCandidatePinned,
								disabled: !canTogglePinnedProjectPath,
								loading: isUpdatingPinnedProjectPath,
								onToggle: togglePinnedProjectPath,
							}}
							browser={{
								open:
									dialog.showBrowser &&
									!isUpdatingPinnedProjectPath &&
									executors.filesAvailable(executorId),
								executorId,
								executorContextKey: executors.pathContextKey(executorId),
								currentPath: dialog.trimmedPath || projectBasePath,
								basePath: projectBasePath,
								isMobile,
								onSelect: (path) => {
									if (isUpdatingPinnedProjectPath) return;
									dialog.setCandidatePath(path);
								},
								onClose: () => (dialog.showBrowser = false),
								button: {
									label: m.git_target_browse_folders(),
									disabled: isUpdatingPinnedProjectPath || !executors.filesAvailable(executorId),
									onclick: () => (dialog.showBrowser = true),
								},
							}}
							feedback={{
								error: dialog.validationStatus === 'invalid' ? dialog.validationError : null,
								worktree:
									dialog.validationStatus === 'valid'
										? {
												disabled: isUpdatingPinnedProjectPath,
												onOpen: () => dialog.openWorktreePicker(),
											}
										: undefined,
							}}
						/>

						<ProjectPinnedPathList
							{pinnedProjectPaths}
							selectedPath={dialog.candidatePath}
							disabled={isUpdatingPinnedProjectPath}
							onSelect={(pinnedPath) => dialog.setCandidatePath(pinnedPath)}
						/>
					</div>
				</div>

				<div class="flex justify-end gap-2 border-t border-border px-4 py-3">
					<button
						type="button"
						onclick={onClose}
						class="rounded-lg bg-muted px-3 py-1.5 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
					>
						{m.git_confirm_cancel()}
					</button>
					<button
						type="button"
						onclick={confirmSelection}
						disabled={!dialog.canConfirm}
						class="rounded-lg px-4 py-1.5 text-sm font-medium transition-all disabled:cursor-not-allowed disabled:opacity-50
							{dialog.canConfirm
							? 'bg-interactive-accent text-interactive-accent-foreground shadow-sm hover:brightness-110'
							: 'bg-muted text-muted-foreground'}"
					>
						{#if dialog.isConfirming}
							<span class="flex items-center gap-1.5">
								<Loader2 class="h-3.5 w-3.5 animate-spin" />
								{m.git_target_ok()}
							</span>
						{:else}
							{m.git_target_ok()}
						{/if}
					</button>
				</div>
			</div>
		</Dialog.Content>
	</Dialog.Root>
{/if}
