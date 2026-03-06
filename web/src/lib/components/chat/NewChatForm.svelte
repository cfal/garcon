<script lang="ts">
	// New-chat form used inside the NewChatDialog. Delegates state management
	// to NewChatFormState and retains only DOM interactions and template logic.

	import { onDestroy, onMount } from 'svelte';
	import type { NewChatConfig } from '$lib/types/app.js';
	import {
		NewChatFormState,
	} from '$lib/chat/new-chat-form-state.svelte.js';
	import { shouldSubmitOnEnter } from '$lib/chat/composer-shortcuts';
	import {
		buildPermissionOptions,
		buildThinkingOptions,
		PROVIDER_MENU_OPTIONS,
		toModelMenuOptions
	} from '$lib/chat/composer-controls';
	import { CLAUDE_PERMISSION_MODES, NON_CLAUDE_PERMISSION_MODES } from '$lib/chat/chat-ui-constants';
	import ComposerBottomBar from './ComposerBottomBar.svelte';
	import { getPreferences, getAppShell, getModelCatalog } from '$lib/context';
	import * as m from '$lib/paraglide/messages.js';
	import DirectoryBrowser from './DirectoryBrowser.svelte';
	import NewChatWorktreeModal from './NewChatWorktreeModal.svelte';
	import Loader2 from '@lucide/svelte/icons/loader-2';
	import Check from '@lucide/svelte/icons/check';
	import X from '@lucide/svelte/icons/x';
	import Pin from '@lucide/svelte/icons/pin';
	import PinOff from '@lucide/svelte/icons/pin-off';

	interface Props {
		prefill?: string;
		onStartChat: (config: NewChatConfig) => void;
		onCancel?: () => void;
	}

	let { prefill = '', onStartChat, onCancel }: Props = $props();

	const preferences = getPreferences();
	const appShell = getAppShell();
	const modelCatalog = getModelCatalog();
	const form = new NewChatFormState(appShell, modelCatalog);
	let isMobile = $state(false);
	let pendingTextareaFocus = $state(true);

	let textareaRef: HTMLTextAreaElement | undefined = $state();
	let imageInputRef: HTMLInputElement | undefined = $state();

	function reseed(): void {
		form.reseed(prefill);
		pendingTextareaFocus = true;
		setTimeout(() => {
			if (textareaRef && form.settingsLoaded) {
				if (prefill) {
					textareaRef.setSelectionRange(0, 0);
					textareaRef.scrollTop = 0;
				}
				textareaRef.focus();
				pendingTextareaFocus = false;
			}
		}, 50);
	}

	onMount(() => {
		reseed();
		form.loadSettingsAndModels();
		const removeSeedListener = appShell.onNewChatDialogSeed(() => reseed());
		const mql = window.matchMedia('(max-width: 768px)');
		isMobile = mql.matches;
		const handleMediaChange = (e: MediaQueryListEvent) => {
			isMobile = e.matches;
		};
		mql.addEventListener('change', handleMediaChange);

		return () => {
			removeSeedListener();
			mql.removeEventListener('change', handleMediaChange);
		};
	});

	// Revalidates selected models whenever the shared model catalog updates.
	$effect(() => {
		void modelCatalog.version;
		form.validateModelAgainstLive('claude');
		form.validateModelAgainstLive('codex');
		form.validateModelAgainstLive('opencode');
	});

	// Focus textarea when path validates successfully, but not while browsing.
	$effect(() => {
		if (form.validationStatus === 'valid' && !form.showBrowser) {
			textareaRef?.focus();
		}
	});

	// Defers initial textarea focus until startup defaults have loaded and the
	// input is visible.
	$effect(() => {
		if (!pendingTextareaFocus || !form.settingsLoaded || form.showBrowser) return;
		if (!textareaRef) return;
		if (prefill) {
			textareaRef.setSelectionRange(0, 0);
			textareaRef.scrollTop = 0;
		}
		textareaRef.focus();
		pendingTextareaFocus = false;
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

	function handleSubmit(): void {
		const config = form.buildConfig();
		if (config) onStartChat(config);
	}

	function handleKeyDown(e: KeyboardEvent): void {
		if (
			e.key === 'Enter'
			&& shouldSubmitOnEnter({
				sendByShiftEnter: preferences.sendByShiftEnter,
				shiftKey: e.shiftKey,
				ctrlKey: e.ctrlKey,
				metaKey: e.metaKey,
				isComposing: e.isComposing,
			})
		) {
			if (!form.canSubmit) return;
			e.preventDefault();
			handleSubmit();
		}
		if (e.key === 'Escape' && onCancel) {
			e.preventDefault();
			onCancel();
		}
	}

	const permissionOptions = $derived(
		buildPermissionOptions(form.provider === 'claude' ? CLAUDE_PERMISSION_MODES : NON_CLAUDE_PERMISSION_MODES)
	);
	const thinkingOptions = $derived(buildThinkingOptions());
	const modelOptions = $derived(toModelMenuOptions(form.modelOptions));
	const sendButtonClass = 'bg-primary text-primary-foreground border-primary/30 hover:bg-primary/90 disabled:bg-muted disabled:text-muted-foreground disabled:border-border disabled:cursor-not-allowed';
</script>

<div class="p-4 sm:p-8 space-y-6">
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
						oninput={() => { form.clearError(); form.resetTabCompletions(); }}
							onkeydown={(e: KeyboardEvent) => {
								if (e.key === 'Tab') {
									e.preventDefault();
									form.handleTabCompletion();
								}
								if (e.key === 'Enter') {
									e.preventDefault();
									form.showBrowser = false;
									textareaRef?.focus();
								}
							}}
						placeholder={form.projectBasePath}
						class="w-full pl-3 pr-8 py-2 text-sm bg-background border border-border rounded-lg focus-visible:ring-2 focus-visible:ring-ring focus-visible:border-ring placeholder-muted-foreground/60 text-foreground"
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
						{isMobile}
					/>
				{/if}
			</div>

				{#if form.validationStatus === 'invalid' && form.validationError}
					<p class="-mt-1 text-xs text-destructive transition-colors">
						{form.validationError}
					</p>
				{:else if form.gitRepoStatus === 'git'}
					<button
						type="button"
						onclick={() => form.openWorktreeModal()}
						class="-mt-1 flex items-center gap-1.5 text-xs text-interactive-accent hover:underline transition-colors"
					>
						{m.chat_new_chat_select_different_worktree()}
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
							<span class="block max-w-[70vw] truncate sm:max-w-[24rem]">{pinnedPath}</span>
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

	<!-- Message input -->
	<div class="relative min-h-[120px] border border-border rounded-lg pb-1.5">
		<input
			bind:this={imageInputRef}
			type="file"
			accept="image/*"
			multiple
			class="hidden"
			onchange={handleImageInputChange}
		/>
		<div class:invisible={!form.settingsLoaded}>
				<textarea
				bind:this={textareaRef}
				bind:value={form.firstMessage}
			onkeydown={handleKeyDown}
			oninput={autoResizeTextarea}
				onpaste={handleMessagePaste}
				placeholder={form.placeholder}
				class="chat-input-placeholder block w-full px-4 py-1.5 sm:py-3 bg-transparent outline-none text-foreground placeholder-muted-foreground resize-none min-h-[44px] max-h-[40vh] sm:max-h-[500px] overflow-y-auto text-base leading-6 transition-all duration-200"
					rows="2"
				></textarea>

			<ComposerBottomBar
				canAttachImages={modelCatalog.supportsImages(form.provider)}
				attachImagesTooltip="Image attachments are unavailable for this provider."
				onAddImage={openImagePicker}
				permissionOptions={permissionOptions}
				selectedPermission={form.permissionMode}
				onPermissionSelect={(mode) => {
					form.permissionMode = mode;
				}}
				thinkingOptions={thinkingOptions}
				selectedThinking={form.thinkingMode}
				onThinkingSelect={(mode) => {
					form.thinkingMode = mode;
				}}
				providerOptions={PROVIDER_MENU_OPTIONS}
				selectedProvider={form.provider}
				onProviderSelect={(provider) => {
					form.selectProvider(provider);
				}}
				modelOptions={modelOptions}
				selectedModel={form.modelValue}
				onModelSelect={(model) => {
					form.handleModelChange(model);
				}}
				canSend={form.canSubmit}
				onSend={handleSubmit}
				sendTitle={m.chat_new_chat_start_session()}
				sendButtonClass={sendButtonClass}
			/>
		</div>
		{#if !form.settingsLoaded}
			<div class="absolute inset-0 flex items-center justify-center rounded-lg bg-background/95">
				<div
					role="status"
					aria-label={m.chat_new_chat_loading_defaults()}
					class="flex h-10 w-10 items-center justify-center rounded-full border border-border bg-muted/30 text-muted-foreground"
				>
					<Loader2 class="h-5 w-5 animate-spin" />
				</div>
			</div>
		{/if}
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
