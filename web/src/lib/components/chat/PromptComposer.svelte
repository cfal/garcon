<script lang="ts">
	import { onMount, onDestroy, tick } from 'svelte';
	import FileMentionMenu from './FileMentionMenu.svelte';
	import ChatToolbar from './ChatToolbar.svelte';
	import { getComposerState, getChatLifecycle, getPreferences, getChatSessions, getAppShell } from '$lib/context';
	import { ImageAttachmentState } from '$lib/chat/image-attachment.svelte.js';
	import { shouldSubmitOnEnter } from '$lib/chat/composer-shortcuts';
	import * as m from '$lib/paraglide/messages.js';
	import { Send, ImagePlus } from '@lucide/svelte';
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
	const preferences = getPreferences();
	const sessions = getChatSessions();
	const appShell = getAppShell();

	let textarea: HTMLTextAreaElement | undefined = $state();
	let fileInput: HTMLInputElement | undefined = $state();

	// Auto-focus textarea when the composer mounts (new chat or chat switch).
	onMount(() => {
		tick().then(() => textarea?.focus());
		return appShell.onComposerFocusRequested(() => textarea?.focus());
	});

	// File mention menu state.
	let showFileMenu = $state(false);
	let fileQuery = $state('');
	let previousComposerChatId = $state<string | null>(sessions.selectedChatId);

	// Resets ephemeral UI state when switching chats without remounting the composer.
	$effect(() => {
		const chatId = sessions.selectedChatId;
		if (chatId === previousComposerChatId) return;
		previousComposerChatId = chatId;
		showFileMenu = false;
		fileQuery = '';
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
		showFileMenu = Boolean(fileMatch);
		fileQuery = fileMatch?.[1] ?? '';
	}

	function insertFileMention(path: string) {
		composerState.inputText = composerState.inputText.replace(/(?:^|\s)@([^\s]*)$/, ` @${path} `);
		showFileMenu = false;
		textarea?.focus();
	}

	// Handles Enter/Shift+Enter submission depending on preference.
	// Defers to the file menu while it is open.
	function handleKeyDown(event: KeyboardEvent) {
		if (showFileMenu) return;
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
		const text = composerState.inputText.trim();
		if (!text && composerState.images.length === 0) return;
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
	const hasInput = $derived(Boolean(composerState.inputText.trim()));
	const sendHint = $derived(
		preferences.sendByShiftEnter ? m.chat_composer_shift_enter_to_send() : m.chat_composer_enter_to_send()
	);

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

	function handleResizeStart(event: MouseEvent) {
		event.preventDefault();
		const startY = event.clientY;
		const startHeight = composerHeight;
		const ta = textarea;
		if (!ta) return;

		document.body.style.cursor = 'row-resize';
		document.body.style.userSelect = 'none';

		function onMouseMove(e: MouseEvent) {
			if (ta) ta.style.minHeight = `${clampHeight(startHeight + startY - e.clientY)}px`;
		}

		function onMouseUp(e: MouseEvent) {
			document.removeEventListener('mousemove', onMouseMove);
			document.removeEventListener('mouseup', onMouseUp);
			document.body.style.cursor = '';
			document.body.style.userSelect = '';
			dragCleanup = null;
			const finalHeight = clampHeight(startHeight + startY - e.clientY);
			composerHeight = finalHeight;
			window.localStorage.setItem(COMPOSER_STORAGE_KEY, String(Math.round(finalHeight)));
		}

		document.addEventListener('mousemove', onMouseMove);
		document.addEventListener('mouseup', onMouseUp);

		dragCleanup = () => {
			document.removeEventListener('mousemove', onMouseMove);
			document.removeEventListener('mouseup', onMouseUp);
			document.body.style.cursor = '';
			document.body.style.userSelect = '';
		};
	}

	onDestroy(() => {
		dragCleanup?.();
		dragCleanup = null;
	});
</script>

<div class="flex-shrink-0">
		<div data-composer class="relative bg-card pb-[env(safe-area-inset-bottom)]">
		<!-- Invisible resize grab zone above the composer (desktop only) -->
		<!-- svelte-ignore a11y_no_static_element_interactions -- resize handle, mouse-only by design -->
		<div
			onmousedown={handleResizeStart}
			class="hidden sm:block absolute left-0 right-0 -top-1 h-2 cursor-row-resize z-10"
		></div>

		<ChatToolbar
			{onModelChange}
			{onPermissionModeChange}
			{onThinkingModeChange}
			onAttachImages={handleImagePick}
		/>

		<FileMentionMenu
			projectPath={sessions.selectedChat?.projectPath || ''}
			isVisible={showFileMenu}
			query={fileQuery}
			onSelect={insertFileMention}
			onClose={() => (showFileMenu = false)}
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
							placeholder={m.chat_composer_placeholder()}
							disabled={isDisabled}
								class="block w-full pl-4 pr-14 sm:pr-16 py-1.5 sm:py-3 bg-transparent outline-none focus-visible:ring-2 focus-visible:ring-ring text-foreground placeholder:text-muted-foreground disabled:opacity-50 resize-none min-h-[44px] max-h-[40vh] sm:max-h-[500px] overflow-y-auto text-base leading-6 transition-all duration-200"
								style:min-height="{composerHeight}px"
							></textarea>

							<button
								type="submit"
								disabled={!hasInput || isDisabled}
									class="absolute right-2 top-1/2 transform -translate-y-1/2 w-9 h-9 sm:w-11 sm:h-11 border {isQueueMode ? 'bg-status-info text-status-info-foreground border-status-info-border hover:bg-status-info/85' : 'bg-primary text-primary-foreground border-primary/30 hover:bg-primary/90'} disabled:bg-muted disabled:text-muted-foreground disabled:border-border disabled:cursor-not-allowed rounded-full flex items-center justify-center transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 ring-offset-background"
									title={isQueueMode ? m.chat_composer_queue_message() : m.chat_composer_send_message()}
								>
								<Send class="w-4 h-4 sm:w-5 sm:h-5" />
						</button>

						<div
								class="absolute bottom-1 left-4 right-14 sm:right-16 text-xs text-muted-foreground pointer-events-none hidden sm:block transition-opacity duration-200 {hasInput ? 'opacity-0' : 'opacity-100'}"
							>
							{sendHint}
						</div>
					</div>
				</div>
			</form>
		</div>
	</div>
