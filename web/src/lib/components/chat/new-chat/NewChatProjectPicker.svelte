<script lang="ts">
	import { tick, untrack } from 'svelte';
	import type { NewChatFormState } from '$lib/chat/new-chat/new-chat-form-state.svelte';
	import { getExecutors } from '$lib/context';
	import ExecutorSelector from '$lib/components/shared/ExecutorSelector.svelte';
	import ProjectPathField from '$lib/components/project-paths/ProjectPathField.svelte';
	import NewChatProjects from './NewChatProjects.svelte';
	import NewChatWorktrees from './NewChatWorktrees.svelte';
	import FolderOpen from '@lucide/svelte/icons/folder-open';
	import * as m from '$lib/paraglide/messages.js';

	let { form, isMobile }: { form: NewChatFormState; isMobile: boolean } = $props();
	const executors = getExecutors();
	let pathInput = $state<HTMLInputElement | null>(null);
	let pathFieldOpen = $state(false);
	let browserPath = $state('');
	const browseContextKey = $derived(form.pathContextKey);
	const displayedPath = $derived(form.showBrowser ? browserPath : form.projectPath);
	const displaysSelectedPath = $derived(displayedPath === form.projectPath);

	$effect(() => {
		browseContextKey;
		const filesAvailable = form.filesAvailable;
		untrack(() => {
			browserPath = form.projectBasePath;
			if (!filesAvailable) form.showBrowser = false;
		});
	});

	async function toggleBrowser(): Promise<void> {
		if (pathFieldOpen && form.showBrowser) {
			form.showBrowser = false;
			pathFieldOpen = false;
			return;
		}
		pathFieldOpen = true;
		form.resetTabCompletions();
		browserPath = form.projectBasePath;
		form.showBrowser = true;
		if (form.showBrowser && !isMobile) {
			await tick();
			pathInput?.focus();
		}
	}

	async function enterPath(): Promise<void> {
		pathFieldOpen = true;
		form.resetTabCompletions();
		form.showBrowser = false;
		await tick();
		pathInput?.focus();
	}

	async function completePath(): Promise<void> {
		const contextKey = form.pathContextKey;
		if (displayedPath !== form.projectPath) form.editProjectPath(displayedPath);
		await form.handleTabCompletion();
		if (contextKey === form.pathContextKey) browserPath = form.projectPath;
	}
</script>

<div class="mx-auto w-full max-w-md space-y-2" data-slot="new-chat-project-picker">
	<NewChatProjects {form}>
		{#snippet actions()}
			<button
				type="button"
				disabled={!form.filesAvailable || form.isUpdatingPinnedPath}
				onclick={() => void toggleBrowser()}
				aria-expanded={form.showBrowser}
				class="inline-flex h-[42px] shrink-0 sm:pointer-fine:h-[38px] items-center gap-2 rounded-md px-2 text-sm font-medium text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
			>
				<FolderOpen class="size-4" aria-hidden="true" />{m.chat_new_chat_choose_project()}
			</button>
		{/snippet}
	</NewChatProjects>
	<div class="relative min-w-0">
		<div class="flex min-w-0 flex-wrap items-stretch gap-2">
			<ExecutorSelector
				{executors}
				executorId={form.executorId}
				service="agents"
				presentation="field"
				class="h-[42px] max-w-full sm:pointer-fine:h-[38px]"
				onSelect={(executorId) => form.selectExecutor(executorId)}
			/>
			{#if isMobile || !form.filesAvailable}
				<button
					type="button"
					disabled={form.isUpdatingPinnedPath}
					onclick={() => void enterPath()}
					class="inline-flex min-h-10 items-center rounded-md px-3 text-sm text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
				>{m.chat_new_chat_enter_path()}</button>
			{/if}
		</div>
		{#if pathFieldOpen}
			{#key browseContextKey}
				<ProjectPathField
					bind:ref={pathInput}
					value={displayedPath}
					aria-label={m.chat_new_chat_project_path()}
					placeholder={form.projectBasePath}
					disabled={form.isUpdatingPinnedPath}
					validationStatus={displaysSelectedPath ? form.validationStatus : 'idle'}
					validationError={displaysSelectedPath ? form.validationError : null}
					class="relative z-30 mt-2"
					oninput={(event) => {
						browserPath = event.currentTarget.value;
						form.resetTabCompletions();
						form.editProjectPath(browserPath);
					}}
					onkeydown={(event) => {
						if (event.key === 'Tab' && !event.shiftKey && form.filesAvailable) {
							event.preventDefault();
							void completePath();
							return;
						}
						if (event.key !== 'Enter' && event.key !== 'Escape') return;
						if (event.key === 'Escape' && !form.showBrowser) return;
						event.preventDefault();
						event.stopPropagation();
						const enteredPath = displayedPath;
						form.showBrowser = false;
						if (event.key === 'Enter') {
							if (enteredPath !== form.projectPath) form.selectProjectPath(enteredPath);
							else form.validatePath();
						}
					}}
					browser={{
						open: form.filesAvailable && form.showBrowser && !form.isUpdatingPinnedPath,
						executorId: form.executorId,
						executorContextKey: form.pathContextKey,
						currentPath: browserPath,
						initialDirectory: form.projectBasePath,
						basePath: form.projectBasePath,
						isMobile,
						onSelect: (path) => {
							browserPath = path;
							form.selectProjectPath(path);
							if (isMobile) form.showBrowser = false;
						},
						onClose: () => (form.showBrowser = false),
					}}
				/>
			{/key}
		{/if}
	</div>
	<NewChatWorktrees {form} />
</div>
