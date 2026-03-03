<script lang="ts">
	import { onMount, onDestroy, tick } from 'svelte';
	import FileMentionMenu from './FileMentionMenu.svelte';
	import ComposerBottomBar from './ComposerBottomBar.svelte';
	import { getComposerState, getChatLifecycle, getPreferences, getChatSessions, getAppShell, getModelCatalog, getProviderState } from '$lib/context';
	import { ImageAttachmentState } from '$lib/chat/image-attachment.svelte.js';
	import { shouldSubmitOnEnter, canSubmitComposer } from '$lib/chat/composer-shortcuts';
	import { PromptComposerUiState } from './prompt-composer-state.svelte';
	import { buildPermissionOptions, buildThinkingOptions, toModelMenuOptions } from '$lib/chat/composer-controls';
	import { CLAUDE_PERMISSION_MODES, NON_CLAUDE_PERMISSION_MODES } from '$lib/chat/chat-ui-constants';
	import * as m from '$lib/paraglide/messages.js';
	import { ImagePlus } from '@lucide/svelte';
	import type { PermissionMode } from '$lib/types/chat';

	interface Props {
		onsubmit: () => void;
		onModelChange?: (model: string) => void;
		onPermissionModeChange?: (mode: PermissionMode) => void;
		onThinkingModeChange?: (mode: string) => void;
	}

	let { onsubmit, onModelChange, onPermissionModeChange, onThinkingModeChange }: Props = $props();

	const composerState = getComposerState();
	const lifecycle = getChatLifecycle();
	const providerState = getProviderState();
	const preferences = getPreferences();
	const sessions = getChatSessions();
	const appShell = getAppShell();
	const modelCatalog = getModelCatalog();

	let textarea: HTMLTextAreaElement | undefined = $state();
	let fileInput: HTMLInputElement | undefined = $state();

	// Auto-focus textarea when the composer mounts (new chat or chat switch).
	onMount(() => {
		tick().then(() => textarea?.focus());
		return appShell.onComposerFocusRequested(() => textarea?.focus());
	});

	// Ephemeral UI state extracted to companion class.
	const ui = new PromptComposerUiState();
	ui.previousChatId = sessions.selectedChatId;

	// Resets ephemeral UI state when switching chats without remounting the composer.
	$effect(() => {
		const changed = ui.resetOnChatSwitch(sessions.selectedChatId);
		if (!changed) return;
		composerState.isDragActive = false;
		requestAnimationFrame(() => {
			autoResize();
			textarea?.focus();
		});
	});

	// Shared image URL lifecycle management. Syncs blob URLs with
	// composerState.images and revokes stale URLs automatically.
	const imageAttachments = new ImageAttachmentState();

	$effect(() => {
		imageAttachments.images = composerState.images;
		imageAttachments.syncUrls();
	});

	onDestroy(() => {
		imageAttachments.revokeAll();
	});

	// Auto-resize textarea to content height.
	function autoResize() {
		if (!textarea) return;
		textarea.style.height = 'auto';
		textarea.style.height = `${Math.min(textarea.scrollHeight, 300)}px`;
	}

	/** Detects "@" trigger prefixes relative to caret position. */
	function updateFileTrigger(value: string, caret: number) {
		const prefix = value.slice(0, caret);
		const fileMatch = prefix.match(/(?:^|\s)@([^\s]*)$/);
		ui.showFileMenu = Boolean(fileMatch);
		ui.fileQuery = fileMatch?.[1] ?? '';
	}

	function insertFileMention(path: string) {
		composerState.inputText = composerState.inputText.replace(/(?:^|\s)@([^\s]*)$/, ` @${path} `);
		ui.showFileMenu = false;
		textarea?.focus();
	}

	// Handles Enter/Shift+Enter submission depending on preference.
	// Defers to the file menu while it is open.
	function handleKeyDown(event: KeyboardEvent) {
		if (ui.showFileMenu) return;
		if (event.key !== 'Enter') return;
		if (
			!shouldSubmitOnEnter({
				sendByShiftEnter: preferences.sendByShiftEnter,
				shiftKey: event.shiftKey,
				ctrlKey: event.ctrlKey,
				metaKey: event.metaKey,
				isComposing: event.isComposing,
			})
		) return;

		event.preventDefault();
		handleFormSubmit();
	}

	function handleFormSubmit() {
		if (!canSubmit) return;
		onsubmit();
	}

	function handleInput() {
		autoResize();
		const caret = textarea?.selectionStart ?? composerState.inputText.length;
		updateFileTrigger(composerState.inputText, caret);
		// Auto-save draft on input.
		const chatId = sessions.selectedChatId;
		if (chatId) {
			composerState.saveDraft(chatId);
		}
	}

	function handleImagePick() {
		fileInput?.click();
	}

	function handleFileChange(event: Event) {
		const input = event.target as HTMLInputElement;
		if (!input.files) return;
		composerState.addImages(Array.from(input.files));
		input.value = '';
	}

	// Drag-and-drop handlers for image attachment.
	function handleDragOver(event: DragEvent) {
		event.preventDefault();
		composerState.isDragActive = true;
	}

	function handleDragLeave() {
		composerState.isDragActive = false;
	}

	function handleDrop(event: DragEvent) {
		event.preventDefault();
		composerState.isDragActive = false;
		const files = event.dataTransfer?.files;
		if (!files) return;
		const imageFiles = Array.from(files).filter((f) => f.type.startsWith('image/'));
		composerState.addImages(imageFiles);
	}

	// Paste handler for images from clipboard.
	function handlePaste(event: ClipboardEvent) {
		const items = event.clipboardData?.items;
		if (!items) return;
		const imageFiles: File[] = [];
		for (const item of items) {
			if (item.type.startsWith('image/')) {
				const file = item.getAsFile();
				if (file) imageFiles.push(file);
			}
		}
		if (imageFiles.length > 0) {
			composerState.addImages(imageFiles);
		}
	}

	const isDraftStartupLoading = $derived(
		lifecycle.isLoading && sessions.selectedChat?.status === 'draft'
	);
	const isQueueMode = $derived(
		Boolean(sessions.selectedChat?.status === 'running' && sessions.selectedChat?.isProcessing)
	);
	const isDisabled = $derived(isDraftStartupLoading);
	const canSubmit = $derived(
		canSubmitComposer(isDisabled, composerState.inputText, composerState.images.length)
	);
	const permissionOptions = $derived(
		buildPermissionOptions(
			providerState.provider === 'claude' ? CLAUDE_PERMISSION_MODES : NON_CLAUDE_PERMISSION_MODES
		)
	);
	const thinkingOptions = $derived(buildThinkingOptions());
	const modelOptions = $derived(
		toModelMenuOptions(modelCatalog.getModels(providerState.provider))
	);
	const canAttachImages = $derived(modelCatalog.supportsImages(providerState.provider));
	const sendButtonClass = 'bg-primary text-primary-foreground border-primary/30 hover:bg-primary/90';

	// Composer resize via drag handle. Persists height to localStorage and
	// mutates the DOM directly during drag to avoid render latency.
	const COMPOSER_STORAGE_KEY = 'composerHeight';
	const COMPOSER_DEFAULT_HEIGHT = 360;
	const COMPOSER_MIN_HEIGHT = 52;
	const COMPOSER_MAX_HEIGHT = 500;

	function clampHeight(h: number): number {
		return Math.max(COMPOSER_MIN_HEIGHT, Math.min(COMPOSER_MAX_HEIGHT, h));
	}

	let composerHeight = $state(COMPOSER_DEFAULT_HEIGHT);
	let dragCleanup: (() => void) | null = null;

	// Initialise from localStorage on mount.
	$effect(() => {
		if (typeof window === 'undefined') return;
		const stored = Number(window.localStorage.getItem(COMPOSER_STORAGE_KEY));
		if (Number.isFinite(stored)) composerHeight = clampHeight(stored);
	});

	function handleResizeStart(event: PointerEvent) {
		event.preventDefault();
		const startY = event.clientY;
		const startHeight = composerHeight;
		const ta = textarea;
		if (!ta) return;

		document.body.style.cursor = 'row-resize';
		document.body.style.userSelect = 'none';
		document.body.style.touchAction = 'none';

		function onPointerMove(e: PointerEvent) {
			if (ta) ta.style.minHeight = `${clampHeight(startHeight + startY - e.clientY)}px`;
		}

		function onPointerUp(e: PointerEvent) {
			document.removeEventListener('pointermove', onPointerMove);
			document.removeEventListener('pointerup', onPointerUp);
			document.body.style.cursor = '';
			document.body.style.userSelect = '';
			document.body.style.touchAction = '';
			dragCleanup = null;
			const finalHeight = clampHeight(startHeight + startY - e.clientY);
			composerHeight = finalHeight;
			window.localStorage.setItem(COMPOSER_STORAGE_KEY, String(Math.round(finalHeight)));
		}

		document.addEventListener('pointermove', onPointerMove);
		document.addEventListener('pointerup', onPointerUp);

		dragCleanup = () => {
			document.removeEventListener('pointermove', onPointerMove);
			document.removeEventListener('pointerup', onPointerUp);
			document.body.style.cursor = '';
			document.body.style.userSelect = '';
			document.body.style.touchAction = '';
		};
	}

	onDestroy(() => {
		dragCleanup?.();
		dragCleanup = null;
	});
</script>

<div class="flex-shrink-0">
		<div data-composer class="relative bg-card border-t border-border pb-1 sm:pb-2">
		<!-- Invisible resize grab zone above the composer -->
		<!-- svelte-ignore a11y_no_static_element_interactions -- pointer drag handle -->
		<div
			onpointerdown={handleResizeStart}
			class="absolute left-0 right-0 -top-1 h-3 cursor-row-resize z-10 touch-none"
		></div>

		<FileMentionMenu
			projectPath={sessions.selectedChat?.projectPath || ''}
			isVisible={ui.showFileMenu}
			query={ui.fileQuery}
			onSelect={insertFileMention}
			onClose={() => (ui.showFileMenu = false)}
		/>

			<form
				onsubmit={(e) => {
					e.preventDefault();
					handleFormSubmit();
				}}
				class="relative"
			>
				{#if composerState.isDragActive}
					<div class="absolute inset-0 bg-primary/20 border-2 border-dashed border-primary flex items-center justify-center z-50 rounded-lg">
						<div class="bg-card rounded-lg p-4 shadow-md">
							<ImagePlus class="w-8 h-8 text-primary mx-auto mb-2" />
							<p class="text-sm font-medium text-foreground">{m.chat_composer_drop_images()}</p>
						</div>
					</div>
				{/if}

				{#if composerState.images.length > 0}
					<div class="mb-2 p-2 bg-muted/40 rounded-lg">
						<div class="flex flex-wrap gap-2">
							{#each composerState.images as file, idx (file.name + idx)}
								<div class="relative group">
									<div class="w-16 h-16 rounded-lg overflow-hidden border border-border">
									{#if file.type.startsWith('image/')}
										{@const url = imageAttachments.urlFor(file, idx)}
										{#if url}
											<img
												src={url}
												alt={file.name}
												class="w-full h-full object-cover"
											/>
										{/if}
									{/if}
								</div>
									<button
										type="button"
										class="absolute -top-1 -right-1 w-5 h-5 bg-destructive text-destructive-foreground rounded-full text-xs flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
										onclick={() => composerState.removeImage(idx)}
									>
									x
								</button>
							</div>
						{/each}
					</div>
				</div>
			{/if}

			<input
				bind:this={fileInput}
				type="file"
				accept="image/*"
				multiple
				class="hidden"
				onchange={handleFileChange}
			/>

				<!-- svelte-ignore a11y_no_static_element_interactions -- drag-and-drop region with role=region and aria-label -->
				<div
					class="relative bg-transparent focus-within:ring-0 transition-all duration-200 overflow-hidden"
					ondragover={handleDragOver}
					ondragleave={handleDragLeave}
					ondrop={handleDrop}
					role="region"
					aria-label="Message input area"
				>
					<div class="relative z-10">
						<textarea
							bind:this={textarea}
							bind:value={composerState.inputText}
							onkeydown={handleKeyDown}
							oninput={handleInput}
							onpaste={handlePaste}
							onfocus={() => appShell.requestSidebarRecenterToSelected()}
							placeholder={m.chat_composer_reply_placeholder()}
							disabled={isDisabled}
								class="block w-full px-4 py-1.5 sm:py-3 bg-transparent outline-none focus-visible:ring-2 focus-visible:ring-ring text-foreground placeholder:text-muted-foreground disabled:opacity-50 resize-none min-h-[44px] max-h-[40vh] sm:max-h-[500px] overflow-y-auto text-base leading-6 transition-all duration-200"
								style:min-height="{composerHeight}px"
							></textarea>
					</div>
				</div>

				<ComposerBottomBar
					canAttachImages={canAttachImages}
					attachImagesTooltip="Image attachments are unavailable for this provider."
					onAddImage={handleImagePick}
					permissionOptions={permissionOptions}
					selectedPermission={providerState.permissionMode}
					onPermissionSelect={(mode) => {
						providerState.permissionMode = mode;
						onPermissionModeChange?.(mode);
					}}
					thinkingOptions={thinkingOptions}
					selectedThinking={providerState.thinkingMode}
					onThinkingSelect={(mode) => {
						providerState.thinkingMode = mode;
						onThinkingModeChange?.(mode);
					}}
					modelOptions={modelOptions}
					selectedModel={providerState.model}
					onModelSelect={(model) => {
						providerState.setModel(model);
						onModelChange?.(model);
					}}
					canSend={canSubmit}
					onSend={handleFormSubmit}
					sendTitle={isQueueMode ? m.chat_composer_queue_message() : m.chat_composer_send_message()}
					sendButtonClass={sendButtonClass}
				/>
			</form>
		</div>
	</div>
