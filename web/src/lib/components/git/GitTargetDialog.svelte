<script lang="ts">
	// Selects the Git folder used by the Git panel. Worktree selection updates
	// only the pending path; the active target changes after OK.

	import { onDestroy } from 'svelte';
	import * as Dialog from '$lib/components/ui/dialog';
	import DirectoryBrowser from '$lib/components/chat/DirectoryBrowser.svelte';
	import GitWorktreePickerModal from './GitWorktreePickerModal.svelte';
	import { GitTargetDialogState } from '$lib/stores/git/git-target-dialog.svelte.js';
	import type { GitTargetCandidate } from '$lib/api/git.js';
	import Folder from '@lucide/svelte/icons/folder';
	import FolderOpen from '@lucide/svelte/icons/folder-open';
	import Check from '@lucide/svelte/icons/check';
	import X from '@lucide/svelte/icons/x';
	import Loader2 from '@lucide/svelte/icons/loader-2';
	import * as m from '$lib/paraglide/messages.js';

	interface GitTargetDialogProps {
		initialPath: string;
		projectBasePath: string;
		isMobile: boolean;
		onConfirm: (target: GitTargetCandidate) => void | Promise<void>;
		onClose: () => void;
	}

	let {
		initialPath,
		projectBasePath,
		isMobile,
		onConfirm,
		onClose,
	}: GitTargetDialogProps = $props();

	const dialog = new GitTargetDialogState({
		get initialPath() {
			return initialPath;
		},
	});

	$effect(() => {
		void dialog.candidatePath;
		dialog.scheduleValidation();
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
			dialog.validationError = error instanceof Error ? error.message : m.git_target_switch_failed();
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
						<label for="git-target-path-input" class="block text-sm font-medium text-muted-foreground">
							{m.chat_new_chat_project_path()}
						</label>
						<div class="relative">
							<div class="flex gap-2">
								<div class="relative flex-1">
									<input
										id="git-target-path-input"
										type="text"
										bind:value={dialog.candidatePath}
										onfocus={(event: FocusEvent & { currentTarget: HTMLInputElement }) => {
											if (isMobile) event.currentTarget.blur();
											dialog.showBrowser = true;
										}}
										oninput={() => {
											dialog.validationError = null;
											dialog.worktreeError = null;
										}}
										onkeydown={(event: KeyboardEvent) => {
											if (event.key === 'Enter') {
												event.preventDefault();
												dialog.showBrowser = false;
												void confirmSelection();
											}
										}}
										placeholder={projectBasePath}
										class="w-full rounded-lg border border-border bg-background py-2 pl-3 pr-8 text-sm text-foreground placeholder-muted-foreground/60 focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring"
									/>
									<div class="absolute right-2 top-1/2 -translate-y-1/2">
										{#if !dialog.trimmedPath}
											<!-- no indicator -->
										{:else if dialog.validationStatus === 'checking'}
											<Loader2 class="h-4 w-4 animate-spin text-muted-foreground" />
										{:else if dialog.validationStatus === 'valid'}
											<Check class="h-4 w-4 text-primary" />
										{:else if dialog.validationStatus === 'invalid'}
											<span title={dialog.validationError || m.chat_new_chat_errors_invalid_directory()}>
												<X class="h-4 w-4 text-destructive" />
											</span>
										{/if}
									</div>
								</div>
								<button
									type="button"
									onclick={() => {
										dialog.showBrowser = true;
									}}
									class="rounded-lg border border-border px-3 py-2 text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
									title={m.git_target_browse_folders()}
									aria-label={m.git_target_browse_folders()}
								>
									<FolderOpen class="h-4 w-4" />
								</button>
							</div>

							{#if dialog.showBrowser}
								<DirectoryBrowser
									currentPath={dialog.trimmedPath || projectBasePath}
									basePath={projectBasePath}
									onSelect={(path) => dialog.setCandidatePath(path)}
									onClose={() => (dialog.showBrowser = false)}
									{isMobile}
								/>
							{/if}
						</div>

						<div class="min-h-[1.25rem]">
							{#if dialog.validationStatus === 'invalid' && dialog.validationError}
								<p class="text-xs text-destructive">{dialog.validationError}</p>
							{:else if dialog.validationStatus === 'valid'}
								<button
									type="button"
									onclick={() => dialog.openWorktreePicker()}
									class="flex items-center gap-1.5 text-xs text-interactive-accent transition-colors hover:underline"
								>
									{m.chat_new_chat_select_different_worktree()}
								</button>
							{:else}
								<div aria-hidden="true"></div>
							{/if}
						</div>
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
