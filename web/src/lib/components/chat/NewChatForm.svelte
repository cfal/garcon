<script lang="ts">
	// New-chat form used inside the NewChatDialog. Delegates state management
	// to NewChatFormState and retains only DOM interactions and template logic.

	import { onDestroy, onMount } from 'svelte';
	import type { NewChatConfig } from '$lib/types/app.js';
	import {
		NewChatFormState,
		MODE_LABEL_GETTERS,
		PILL_BASE,
		PROVIDER_PILL_WIDTH,
		THINKING_PILL_WIDTH
	} from '$lib/chat/new-chat-form-state.svelte.js';
	import { MODE_STYLES, DEFAULT_MODE_STYLE } from '$lib/chat/provider-state.svelte.js';
	import { getPreferences, getAppShell } from '$lib/context';
	import * as m from '$lib/paraglide/messages.js';
	import DirectoryBrowser from './DirectoryBrowser.svelte';
	import NewChatWorktreeModal from './NewChatWorktreeModal.svelte';
	import Loader2 from '@lucide/svelte/icons/loader-2';
	import Check from '@lucide/svelte/icons/check';
	import X from '@lucide/svelte/icons/x';
	import Pin from '@lucide/svelte/icons/pin';
	import PinOff from '@lucide/svelte/icons/pin-off';
	import ImagePlus from '@lucide/svelte/icons/image-plus';
	import GitBranch from '@lucide/svelte/icons/git-branch';

	interface Props {
		prefill?: string;
		onStartChat: (config: NewChatConfig) => void;
		onCancel?: () => void;
	}

	let { prefill = '', onStartChat, onCancel }: Props = $props();

	const preferences = getPreferences();
	const appShell = getAppShell();
	const form = new NewChatFormState(preferences, appShell);

	let textareaRef: HTMLTextAreaElement | undefined = $state();
	let imageInputRef: HTMLInputElement | undefined = $state();

	function reseed(): void {
		form.reseed(prefill);
		setTimeout(() => {
			if (textareaRef) {
				if (prefill) {
					textareaRef.setSelectionRange(0, 0);
					textareaRef.scrollTop = 0;
				}
				textareaRef.focus();
			}
		}, 50);
	}

	onMount(() => {
		reseed();
		form.loadSettingsAndModels();
		return appShell.onNewChatDialogSeed(() => reseed());
	});

	// Validate opencode model against live list when it arrives.
	$effect(() => {
		void form.providerModels.opencode;
		form.validateModelAgainstLive('opencode');
	});

	// Validate claude model against live list when it arrives.
	$effect(() => {
		void form.providerModels.claude;
		form.validateModelAgainstLive('claude');
	});

	// Focus textarea when path validates successfully.
	$effect(() => {
		if (form.validationStatus === 'valid') {
			textareaRef?.focus();
		}
	});

	// Reconcile image preview URLs when attached images change.
	$effect(() => {
		void form.attachedImages;
		form.reconcileImageUrls();
	});

	// Debounced path validation reacts to path changes.
	$effect(() => {
		void form.trimmedPath;
		form.validatePath();
	});

	// Detect git repo when path becomes valid.
	$effect(() => {
		void form.validationStatus;
		void form.trimmedPath;
		form.detectGitRepo();
	});

	onDestroy(() => {
		form.revokeAllImageUrls();
	});

	function openImagePicker(): void {
		imageInputRef?.click();
	}

	function handleImageInputChange(event: Event): void {
		const input = event.target as HTMLInputElement;
		if (!input.files) return;
		form.addImages(Array.from(input.files));
		input.value = '';
	}

	function handleMessagePaste(event: ClipboardEvent): void {
		const items = event.clipboardData?.items;
		if (!items) return;
		const pastedImages: File[] = [];
		for (const item of items) {
			if (!item.type.startsWith('image/')) continue;
			const file = item.getAsFile();
			if (file) pastedImages.push(file);
		}
		if (pastedImages.length > 0) form.addImages(pastedImages);
	}

	function autoResizeTextarea(): void {
		if (!textareaRef) return;
		textareaRef.style.height = 'auto';
		textareaRef.style.height = `${textareaRef.scrollHeight}px`;
	}

	function handleModelChange(e: Event): void {
		form.handleModelChange((e.target as HTMLSelectElement).value);
	}

	function handleSubmit(): void {
		const config = form.buildConfig();
		if (config) onStartChat(config);
	}

	function handleKeyDown(e: KeyboardEvent): void {
		if (e.key === 'Tab') {
			e.preventDefault();
			form.cycleProvider();
			return;
		}
		if (e.key === 'Enter' && !e.shiftKey) {
			if (!form.canSubmit) return;
			e.preventDefault();
			handleSubmit();
		}
		if (e.key === 'Escape' && onCancel) {
			e.preventDefault();
			onCancel();
		}
	}
</script>

<div class="p-6 sm:p-8 space-y-6">
	<!-- Project path -->
	<div class="space-y-2">
		<label for="project-path-input" class="block text-sm font-medium text-muted-foreground">
			{m.chat_new_chat_project_path()}
		</label>
		<div class="relative">
			<div class="flex gap-2">
				<div class="relative flex-1">
					<input
						id="project-path-input"
						type="text"
						bind:value={form.projectPath}
						onfocus={() => form.handlePathFocus()}
						oninput={() => form.clearError()}
						placeholder={form.projectBasePath}
						class="w-full pl-3 pr-8 py-2 text-sm bg-background border border-border rounded-lg focus:ring-2 focus:ring-ring focus:border-ring placeholder-muted-foreground/60 text-foreground"
					/>
					<div class="absolute right-2 top-1/2 -translate-y-1/2">
						{#if !form.trimmedPath}
							<!-- no indicator -->
						{:else if form.validationStatus === 'checking'}
							<Loader2
								class="w-4 h-4 animate-spin text-muted-foreground transition-opacity duration-200"
							/>
						{:else if form.validationStatus === 'valid'}
							<Check class="w-4 h-4 text-primary transition-opacity duration-200" />
						{:else if form.validationStatus === 'invalid'}
							<span title={form.validationError || 'Invalid path'}>
								<X class="w-4 h-4 text-destructive transition-opacity duration-200" />
							</span>
						{/if}
					</div>
				</div>
				<button
					type="button"
					onclick={() => form.togglePinnedPath()}
					disabled={!form.trimmedPath}
					class="px-3 py-2 text-sm border border-border rounded-lg hover:bg-muted/50 disabled:opacity-40 transition-colors"
					title={form.isPinnedPath
						? m.chat_new_chat_remove_from_favorites()
						: m.chat_new_chat_add_to_favorites()}
				>
					{#if form.isPinnedPath}
						<PinOff class="w-4 h-4 text-primary" />
					{:else}
						<Pin class="w-4 h-4 text-muted-foreground" />
					{/if}
				</button>
			</div>

			{#if form.showBrowser}
				<DirectoryBrowser
					currentPath={form.trimmedPath || form.browseStartPath || form.projectBasePath}
					basePath={form.projectBasePath}
					onSelect={(selPath) => {
						form.projectPath = selPath;
						form.clearError();
					}}
					onClose={() => (form.showBrowser = false)}
					isMobile={false}
				/>
			{/if}
		</div>

		{#if form.gitRepoStatus === 'git'}
			<button
				type="button"
				onclick={() => form.openWorktreeModal()}
				class="ml-1 flex items-center gap-1.5 text-xs text-interactive-accent hover:underline transition-colors"
			>
				<GitBranch class="w-3 h-3" />
				Select a different worktree
			</button>
		{/if}

		<!-- Pinned paths or placeholder -->
		{#if form.pinnedProjectPaths.length > 0}
			<div class="flex flex-wrap gap-2">
				{#each form.pinnedProjectPaths as pinnedPath (pinnedPath)}
					<button
						type="button"
						class="text-xs px-2.5 py-1 rounded-md border transition-colors {form.projectPath ===
							pinnedPath
							? 'border-border bg-accent text-accent-foreground'
							: 'border-border/70 bg-muted/40 text-muted-foreground hover:bg-accent/60 hover:text-accent-foreground'}"
						onclick={() => {
							form.projectPath = pinnedPath;
							form.clearError();
						}}
					>
						{pinnedPath}
					</button>
				{/each}
			</div>
		{:else}
			<p
				class="text-xs px-2.5 py-1 rounded-md bg-muted/30 text-muted-foreground text-center w-full"
			>
				{m.chat_new_chat_star_bookmark()}
			</p>
		{/if}

		{#if form.error}
			<p class="text-sm text-destructive">{form.error}</p>
		{/if}
	</div>

	<!-- Controls row -->
	<div
		class="flex flex-wrap items-center justify-center gap-2 sm:gap-3 py-1.5 px-3 bg-muted/30 rounded-lg"
	>
		<!-- Provider button -->
		<button
			type="button"
			onclick={() => form.cycleProvider()}
			class="{PILL_BASE} {MODE_STYLES.default.button} {PROVIDER_PILL_WIDTH}"
			title={m.chat_new_chat_switch_provider()}
		>
			<span class="block w-full text-center truncate">{form.providerName}</span>
		</button>

		<!-- Model selector -->
		<select
			value={form.modelValue}
			onchange={handleModelChange}
			class="{PILL_BASE} {MODE_STYLES.default
				.button} w-[12.5rem] sm:w-[13.5rem] shrink-0 cursor-pointer"
		>
			{#each form.modelOptions as opt (opt.value)}
				<option value={opt.value}>{opt.label}</option>
			{/each}
		</select>

		<!-- Permission mode button -->
		<button
			type="button"
			onclick={() => form.cyclePermissionMode()}
			class="{PILL_BASE} max-w-[10rem] sm:max-w-none {form.modeStyle.button}"
			title={m.chat_new_chat_change_mode()}
		>
			<div class="flex items-center gap-2 min-w-0">
				<div class="w-2 h-2 rounded-full flex-shrink-0 {form.modeStyle.dot}"></div>
				<span class="truncate">{MODE_LABEL_GETTERS[form.permissionMode]()}</span>
			</div>
		</button>

		<!-- Thinking mode button -->
		<button
			type="button"
			onclick={() => form.cycleThinkingMode()}
			class="{PILL_BASE} {form.thinkingMode === 'none'
				? MODE_STYLES.default.button
				: DEFAULT_MODE_STYLE.button} {THINKING_PILL_WIDTH}"
			title="Thinking: {form.currentThinkingMode.name()}"
		>
			<span class="flex items-center justify-center gap-1.5 w-full min-w-0">
				<svg
					class="w-4 h-4"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					aria-hidden="true"
				>
					<path
						d="M9 18h6M10 22h4M8.5 14.5A6.5 6.5 0 1115.5 14.5C14.7 15.3 14 16.1 14 17H10c0-.9-.7-1.7-1.5-2.5z"
						stroke-width="2"
						stroke-linecap="round"
						stroke-linejoin="round"
					/>
				</svg>
				<span class="truncate">{form.currentThinkingMode.name()}</span>
			</span>
		</button>

		<button
			type="button"
			onclick={openImagePicker}
			class="w-8 h-8 text-muted-foreground hover:text-foreground rounded-full flex items-center justify-center transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 ring-offset-background"
			title={m.chat_composer_attach_images()}
		>
			<ImagePlus class="w-5 h-5" />
		</button>
	</div>

	<!-- Message input -->
	<div class="relative">
		<input
			bind:this={imageInputRef}
			type="file"
			accept="image/*"
			multiple
			class="hidden"
			onchange={handleImageInputChange}
		/>
		<textarea
			bind:this={textareaRef}
			bind:value={form.firstMessage}
			onkeydown={handleKeyDown}
			oninput={autoResizeTextarea}
			onpaste={handleMessagePaste}
			placeholder={form.placeholder}
			disabled={!form.canSubmit}
			class="chat-input-placeholder block w-full pl-4 pr-14 py-3 bg-background border border-border rounded-xl focus:ring-2 focus:ring-ring focus:border-ring text-foreground placeholder-muted-foreground/60 disabled:opacity-50 resize-none min-h-[56px] max-h-[200px] text-base leading-6"
			rows="2"
		></textarea>
		<button
			type="button"
			onclick={handleSubmit}
			disabled={!form.canSubmit}
			class="absolute right-2 bottom-2 w-10 h-10 bg-primary hover:bg-primary/90 disabled:bg-muted disabled:cursor-not-allowed rounded-full flex items-center justify-center transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 ring-offset-background"
			title={m.chat_new_chat_start_session()}
		>
			<svg
				class="w-5 h-5 text-primary-foreground transform rotate-90"
				fill="none"
				stroke="currentColor"
				viewBox="0 0 24 24"
			>
				<path
					stroke-linecap="round"
					stroke-linejoin="round"
					stroke-width="2"
					d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8"
				/>
			</svg>
		</button>
	</div>

	{#if form.attachedImages.length > 0}
		<div class="p-2 bg-muted/40 rounded-lg">
			<div class="flex flex-wrap gap-2">
				{#each form.attachedImages as file, idx (file.name + idx)}
					<div class="relative group">
						<div class="w-16 h-16 rounded-lg overflow-hidden border border-border">
							{#if form.imageUrlFor(file, idx)}
								<img src={form.imageUrlFor(file, idx)} alt={file.name} class="w-full h-full object-cover" />
							{/if}
						</div>
						<button
							type="button"
							class="absolute -top-1 -right-1 w-5 h-5 bg-destructive text-destructive-foreground rounded-full text-xs flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
							onclick={() => form.removeImage(idx)}
						>
							x
						</button>
					</div>
				{/each}
			</div>
		</div>
	{/if}

	<p class="text-xs text-center text-muted-foreground">
		{m.chat_new_chat_enter_to_start()}
	</p>
</div>

{#if form.worktreeModalOpen}
	<NewChatWorktreeModal
		worktrees={form.worktreeItems}
		isLoading={form.isLoadingWorktrees}
		isCreating={form.isCreatingWorktree}
		errorMessage={form.worktreeError}
		onSelect={(path) => form.selectWorktree(path)}
		onCreate={(path, branch, baseRef) => form.createWorktree(path, branch, baseRef)}
		onRefresh={() => form.loadWorktrees()}
		onClose={() => form.closeWorktreeModal()}
	/>
{/if}
