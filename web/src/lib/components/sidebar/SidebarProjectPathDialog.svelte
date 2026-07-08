<script lang="ts">
	import { onDestroy } from 'svelte';
	import * as Dialog from '$lib/components/ui/dialog';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import DirectoryBrowser from '$lib/components/chat/DirectoryBrowser.svelte';
	import ProjectPinnedPathList from '$lib/components/chat/ProjectPinnedPathList.svelte';
	import { ProjectPathDialogState } from './project-path-dialog-state.svelte';
	import type { ChatProjectPathDialog } from './sidebar-dialogs-state.svelte';
	import FolderOpen from '@lucide/svelte/icons/folder-open';
	import Loader2 from '@lucide/svelte/icons/loader-2';
	import Check from '@lucide/svelte/icons/check';
	import X from '@lucide/svelte/icons/x';
	import * as m from '$lib/paraglide/messages.js';

	interface SidebarProjectPathDialogProps {
		projectPathDialog: ChatProjectPathDialog | null;
		projectBasePath: string;
		pinnedProjectPaths?: string[];
		isMobile: boolean;
		onClose: () => void;
		onConfirm: (chatId: string, projectPath: string) => Promise<void> | void;
	}

	let {
		projectPathDialog,
		projectBasePath,
		pinnedProjectPaths = [],
		isMobile,
		onClose,
		onConfirm,
	}: SidebarProjectPathDialogProps = $props();

	const projectPathDialogState = new ProjectPathDialogState();
	let activeDialogKey = $state('');
	let pathInputRef = $state<HTMLInputElement | null>(null);

	let isOpen = $derived(projectPathDialog !== null);
	let activeProjectBasePath = $derived(projectBasePath || '/');
	let validationMessage = $derived(
		projectPathDialogState.submitError ?? projectPathDialogState.validationError,
	);
	let isPathInvalid = $derived(Boolean(validationMessage));

	$effect(() => {
		if (!projectPathDialog) {
			activeDialogKey = '';
			projectPathDialogState.close();
			return;
		}

		const nextDialogKey = `${projectPathDialog.chatId}:${projectPathDialog.currentProjectPath}`;
		if (activeDialogKey === nextDialogKey) return;

		activeDialogKey = nextDialogKey;
		projectPathDialogState.open(projectPathDialog.currentProjectPath);
	});

	$effect(() => {
		void projectPathDialogState.trimmedPath;
		projectPathDialogState.scheduleValidation();
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
		if (projectPathDialogState.isSubmitting) return;
		projectPathDialogState.setCandidatePath(path);
		projectPathDialogState.showBrowser = false;
	}

	async function submitProjectPath(): Promise<void> {
		if (!projectPathDialog || !projectPathDialogState.canSubmit) return;

		projectPathDialogState.isSubmitting = true;
		projectPathDialogState.submitError = null;
		try {
			await onConfirm(projectPathDialog.chatId, projectPathDialogState.trimmedPath);
			onClose();
		} catch (error) {
			projectPathDialogState.setSubmitFailure(error);
		} finally {
			projectPathDialogState.isSubmitting = false;
		}
	}
</script>

<Dialog.Root open={isOpen} onOpenChange={handleOpenChange}>
	<Dialog.Content
		class="h-dvh w-full max-w-full rounded-none border-0 p-0 sm:h-auto sm:max-w-lg sm:rounded-lg sm:border"
		onOpenAutoFocus={handleOpenAutoFocus}
	>
		<div class="flex h-full flex-col sm:h-auto">
			<Dialog.Header class="border-b border-border px-5 py-4">
				<Dialog.Title>{m.sidebar_project_path_title()}</Dialog.Title>
				<Dialog.Description class="min-w-0 truncate">
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

				<div class="space-y-1.5">
					<label
						for="sidebar-project-path-input"
						class="block text-sm font-medium text-muted-foreground"
					>
						{m.sidebar_project_path_new_label()}
					</label>
					<div class="relative">
						<div class="flex gap-2">
							<div class="relative min-w-0 flex-1">
								<Input
									id="sidebar-project-path-input"
									bind:ref={pathInputRef}
									type="text"
									bind:value={projectPathDialogState.candidatePath}
									placeholder={activeProjectBasePath}
									disabled={projectPathDialogState.isSubmitting}
									aria-invalid={isPathInvalid}
									aria-describedby="sidebar-project-path-feedback"
									oninput={() => {
										projectPathDialogState.submitError = null;
									}}
									onkeydown={handlePathKeydown}
									class="pr-9 font-mono text-base sm:text-xs"
								/>
								<div class="absolute right-2 top-1/2 -translate-y-1/2">
									{#if !projectPathDialogState.trimmedPath}
										<span aria-hidden="true"></span>
									{:else if projectPathDialogState.validationStatus === 'checking'}
										<Loader2 class="h-4 w-4 animate-spin text-muted-foreground" />
									{:else if projectPathDialogState.validationStatus === 'valid'}
										<Check class="h-4 w-4 text-status-success-foreground" />
									{:else if projectPathDialogState.validationStatus === 'invalid'}
										<X class="h-4 w-4 text-destructive" />
									{/if}
								</div>
							</div>
							<Button
								type="button"
								variant="outline"
								size="icon"
								disabled={projectPathDialogState.isSubmitting}
								onclick={() => {
									projectPathDialogState.showBrowser = true;
								}}
								title={m.sidebar_project_path_browse()}
								aria-label={m.sidebar_project_path_browse()}
							>
								<FolderOpen class="h-4 w-4" />
							</Button>
						</div>

						{#if projectPathDialogState.showBrowser}
							<DirectoryBrowser
								currentPath={projectPathDialogState.trimmedPath || activeProjectBasePath}
								basePath={activeProjectBasePath}
								onSelect={(path) => projectPathDialogState.setCandidatePath(path)}
								onClose={() => (projectPathDialogState.showBrowser = false)}
								{isMobile}
							/>
						{/if}
					</div>
				</div>

				<ProjectPinnedPathList
					{pinnedProjectPaths}
					selectedPath={projectPathDialogState.candidatePath}
					disabled={projectPathDialogState.isSubmitting}
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
				<Button variant="outline" onclick={onClose} disabled={projectPathDialogState.isSubmitting}>
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
