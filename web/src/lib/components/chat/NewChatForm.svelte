<script lang="ts">
	// New-chat form used inside the NewChatDialog. Delegates state management
	// to NewChatFormState and retains only DOM interactions and template logic.

	import { onDestroy, onMount } from 'svelte';
	import type { NewChatConfig } from '$lib/types/app.js';
	import { NewChatFormState } from '$lib/chat/new-chat-form-state.svelte.js';
	import {
		CHAT_ATTACHMENT_ACCEPT,
		isImageAttachment,
	} from '$lib/chat/image-attachment.svelte.js';
	import { shouldSubmitOnEnter } from '$lib/chat/composer-shortcuts';
	import { buildPermissionOptions, buildThinkingOptions } from '$lib/chat/composer-controls';
	import {
		CLAUDE_PERMISSION_MODES,
		NON_CLAUDE_PERMISSION_MODES,
	} from '$lib/chat/chat-ui-constants';
	import ComposerBottomBar from './ComposerBottomBar.svelte';
	import { getLocalSettings, getAppShell, getModelCatalog, getRemoteSettings } from '$lib/context';
	import * as m from '$lib/paraglide/messages.js';
	import DirectoryBrowser from './DirectoryBrowser.svelte';
	import ProjectPinnedPathList from './ProjectPinnedPathList.svelte';
	import GitWorktreePickerModal from '$lib/components/git/GitWorktreePickerModal.svelte';
	import Loader2 from '@lucide/svelte/icons/loader-2';
	import Check from '@lucide/svelte/icons/check';
	import FileText from '@lucide/svelte/icons/file-text';
	import X from '@lucide/svelte/icons/x';
	import Pin from '@lucide/svelte/icons/pin';
	import PinOff from '@lucide/svelte/icons/pin-off';
	import Tag from '@lucide/svelte/icons/tag';
	import { getTagColorClasses } from '$lib/utils/tag-colors';
	import { getChatSessions } from '$lib/context';
	import ComposerModelSelector from '$lib/components/model-selector/ComposerModelSelector.svelte';
	import type {
		ModelSelectorChange,
		ModelSelectorMode,
	} from '$lib/components/model-selector/model-selector-types';
	import { buildModelSelectorRecents } from '$lib/components/model-selector/model-selector-recents';

	interface Props {
		prefill?: string;
		onStartChat: (config: NewChatConfig) => void;
		onCancel?: () => void;
	}

	let { prefill = '', onStartChat, onCancel }: Props = $props();

	const localSettings = getLocalSettings();
	const appShell = getAppShell();
	const modelCatalog = getModelCatalog();
	const remoteSettings = getRemoteSettings();
	const sessions = getChatSessions();
	const form = new NewChatFormState(modelCatalog, remoteSettings);

	let isMobile = $state(false);
	let pendingTextareaFocus = $state(true);
	let tagInputValue = $state('');
	let tagInputRef = $state<HTMLInputElement | null>(null);

	const allKnownTags = $derived(
		Array.from(new Set(sessions.orderedChats.flatMap((c) => c.tags))).sort(),
	);
	const tagSuggestions = $derived.by(() => {
		const q = tagInputValue.trim().toLowerCase();
		if (!q) return [];
		const currentSet = new Set(form.chatTags.map((t) => t.toLowerCase()));
		return allKnownTags
			.filter((t) => t.toLowerCase().startsWith(q) && !currentSet.has(t.toLowerCase()))
			.slice(0, 5);
	});

	function handleTagAdd(raw: string): void {
		if (form.addTag(raw)) {
			tagInputValue = '';
			tagInputRef?.focus();
		}
	}

	function handleTagInputKeydown(e: KeyboardEvent): void {
		if (e.key === 'Enter' || e.key === ',') {
			e.preventDefault();
			if (tagInputValue.trim()) handleTagAdd(tagInputValue);
		} else if (e.key === 'Backspace' && !tagInputValue && form.chatTags.length > 0) {
			form.removeTag(form.chatTags[form.chatTags.length - 1]);
		} else if (e.key === 'Escape') {
			e.preventDefault();
			e.stopPropagation();
			form.showTagInput = false;
		}
	}

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
		form.validateAllModelsAgainstLive();
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
			e.key === 'Enter' &&
			shouldSubmitOnEnter({
				sendByShiftEnter: localSettings.sendByShiftEnter,
				shiftKey: e.shiftKey,
				ctrlKey: e.ctrlKey,
				metaKey: e.metaKey,
				isComposing: e.isComposing,
				isMobile,
			})
		) {
			if (!form.canSubmit) return;
			e.preventDefault();
			handleSubmit();
		}
		if (e.key === 'Escape' && onCancel) {
			e.preventDefault();
			e.stopPropagation();
			onCancel();
		}
	}

	const permissionOptions = $derived(
		buildPermissionOptions(
			form.agentId === 'claude' ? CLAUDE_PERMISSION_MODES : NON_CLAUDE_PERMISSION_MODES,
		),
	);
	const thinkingOptions = $derived(buildThinkingOptions());
	const modelSelectorMode: ModelSelectorMode = {
		agent: 'select',
		source: 'select',
		surface: 'composer',
	};
	const modelSelectorValue = $derived({
		agentId: form.agentId,
		model: form.modelValue,
	});
	const recentSelectorOptions = $derived.by(() =>
		buildModelSelectorRecents(modelCatalog, remoteSettings.snapshot?.recentAgentSettings ?? []),
	);
	const preferRecentsOnOpen = $derived(recentSelectorOptions.length > 1);
	const sendButtonClass =
		'bg-primary text-primary-foreground border-primary/30 hover:bg-primary/90 disabled:bg-muted disabled:text-muted-foreground disabled:border-border disabled:cursor-not-allowed';

	function handleModelSelectorChange(next: ModelSelectorChange): void {
		form.selectAgent(next.agentId);
		form.handleModelChange(next.modelValue);
	}
</script>

<div class="p-4 sm:p-8">
	<div class="relative">
		<div
			class="space-y-6"
			class:invisible={!form.settingsLoaded}
			class:pointer-events-none={!form.settingsLoaded}
			aria-hidden={!form.settingsLoaded}
		>
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
								onfocus={(e: FocusEvent & { currentTarget: HTMLInputElement }) => {
									if (isMobile) {
										e.currentTarget.blur();
									}
									form.handlePathFocus();
								}}
								oninput={() => {
									form.clearError();
									form.resetTabCompletions();
								}}
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
								class="w-full pl-3 pr-8 py-2 text-base sm:text-sm bg-background border border-border rounded-lg focus-visible:ring-2 focus-visible:ring-ring focus-visible:border-ring placeholder-muted-foreground/60 text-foreground"
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
									<span title={form.validationError || m.chat_new_chat_errors_invalid_directory()}>
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
						<button
							type="button"
							onclick={() => {
								form.toggleTagInput();
								if (form.showTagInput) {
									setTimeout(() => tagInputRef?.focus(), 50);
								}
							}}
							class="px-3 py-2 text-sm border border-border rounded-lg hover:bg-muted/50 transition-colors"
							title={m.chat_new_chat_tags_add()}
						>
							<Tag
								class="w-4 h-4 {form.chatTags.length > 0
									? 'text-primary'
									: 'text-muted-foreground'}"
							/>
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

				<div class="-mt-1 min-h-[1.25rem]">
					{#if form.validationStatus === 'invalid' && form.validationError}
						<p class="text-xs text-destructive transition-colors">
							{form.validationError}
						</p>
					{:else if form.gitRepoStatus === 'git'}
						<button
							type="button"
							onclick={() => form.openWorktreeModal()}
							class="flex items-center gap-1.5 text-xs text-interactive-accent hover:underline transition-colors"
						>
							{m.chat_new_chat_select_different_worktree()}
						</button>
					{:else}
						<div aria-hidden="true"></div>
					{/if}
				</div>

				<ProjectPinnedPathList
					pinnedProjectPaths={form.pinnedProjectPaths}
					selectedPath={form.projectPath}
					emptyLabel={m.chat_new_chat_star_bookmark()}
					onSelect={(pinnedPath) => {
						form.projectPath = pinnedPath;
						form.clearError();
					}}
				/>

				{#if form.showTagInput || form.chatTags.length > 0}
					<div class="space-y-2">
						<div class="flex flex-wrap items-center gap-1.5">
							{#each form.chatTags as tag (tag)}
								<button
									type="button"
									class="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium hover:opacity-80 transition-opacity {getTagColorClasses(
										tag,
									)}"
									onclick={() => form.removeTag(tag)}
								>
									{tag}
									<X class="w-3 h-3" />
								</button>
							{/each}
							{#if form.showTagInput}
								<div class="relative flex-1 min-w-[120px]">
									<input
										bind:this={tagInputRef}
										type="text"
										bind:value={tagInputValue}
										onkeydown={handleTagInputKeydown}
										placeholder={m.chat_new_chat_tags_placeholder()}
										class="w-full px-2 py-1 text-xs bg-transparent border-none outline-none placeholder-muted-foreground/60 text-foreground"
									/>
									{#if tagSuggestions.length > 0}
										<div
											class="absolute z-10 mt-1 w-full rounded-md border border-border bg-popover shadow-md"
										>
											{#each tagSuggestions as suggestion (suggestion)}
												<button
													type="button"
													class="w-full text-left px-3 py-1.5 text-xs hover:bg-accent transition-colors first:rounded-t-md last:rounded-b-md"
													onclick={() => handleTagAdd(suggestion)}
												>
													{suggestion}
												</button>
											{/each}
										</div>
									{/if}
								</div>
							{/if}
						</div>
					</div>
				{/if}

				{#if form.error}
					<p class="text-sm text-destructive">{form.error}</p>
				{/if}
			</div>

			<div class="relative min-h-[120px] border border-border rounded-lg pb-1.5">
					<input
						bind:this={imageInputRef}
						type="file"
						accept={CHAT_ATTACHMENT_ACCEPT}
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
					class="chat-input-placeholder block w-full px-4 py-1.5 sm:py-3 bg-transparent outline-none text-foreground placeholder-muted-foreground resize-none min-h-[44px] max-h-[40vh] sm:max-h-[500px] overflow-y-auto text-base leading-6 transition-all duration-200"
					rows="2"
				></textarea>

				<ComposerBottomBar
					canAttachImages={modelCatalog.supportsImages(form.agentId, form.modelValue)}
					attachImagesTooltip={m.chat_composer_image_attachments_unavailable()}
					onAddImage={openImagePicker}
					{permissionOptions}
					selectedPermission={form.permissionMode}
					onPermissionSelect={(mode) => {
						form.setPermissionMode(mode);
					}}
					{thinkingOptions}
					selectedThinking={form.thinkingMode}
					onThinkingSelect={(mode) => {
						form.setThinkingMode(mode);
					}}
					canSend={form.canSubmit}
					onSend={handleSubmit}
					sendTitle={m.chat_new_chat_start_session()}
					{sendButtonClass}
					mobileRightGroupFullRow={true}
				>
					{#snippet modelSelector()}
						<ComposerModelSelector
							value={modelSelectorValue}
							mode={modelSelectorMode}
							onChange={handleModelSelectorChange}
							recents={recentSelectorOptions}
							{preferRecentsOnOpen}
							align="end"
							side="bottom"
						/>
					{/snippet}
				</ComposerBottomBar>
			</div>

			{#if form.attachedImages.length > 0}
				<div class="p-2 bg-muted/40 rounded-lg">
					<div class="flex flex-wrap gap-2">
						{#each form.attachedImages as file, idx (file.name + idx)}
								<div class="relative group">
									<div class="w-16 h-16 rounded-lg overflow-hidden border border-border">
										{#if isImageAttachment(file) && form.imageUrlFor(file, idx)}
											<img
												src={form.imageUrlFor(file, idx)}
												alt={file.name}
												class="w-full h-full object-cover"
											/>
										{:else}
											<div
												class="flex h-full w-full flex-col items-center justify-center gap-1 bg-background px-1 text-muted-foreground"
											>
												<FileText class="h-5 w-5" aria-hidden="true" />
												<span class="w-full truncate text-center text-[10px] leading-tight">{file.name}</span>
											</div>
										{/if}
									</div>
								<button
									type="button"
									aria-label={m.chat_composer_remove_image({ name: file.name })}
									title={m.chat_composer_remove_image({ name: file.name })}
									class="absolute -top-1 -right-1 w-5 h-5 bg-destructive text-destructive-foreground rounded-full text-xs flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
									onclick={() => form.removeImage(idx)}
								>
									<X class="w-3 h-3" aria-hidden="true" />
								</button>
							</div>
						{/each}
					</div>
				</div>
			{/if}
		</div>

		{#if !form.settingsLoaded}
			<div class="absolute inset-0 flex items-center justify-center">
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
</div>

{#if form.worktreeModalOpen}
	<GitWorktreePickerModal
		worktrees={form.worktreeItems}
		isLoading={form.isLoadingWorktrees}
		isCreating={form.isCreatingWorktree}
		errorMessage={form.worktreeError}
		onSelect={(path) => form.selectWorktree(path)}
		onCreate={async (path, branch, baseRef) => {
			await form.createWorktree(path, branch, baseRef);
		}}
		onRefresh={() => {
			void form.loadWorktrees();
		}}
		onClose={() => form.closeWorktreeModal()}
	/>
{/if}
