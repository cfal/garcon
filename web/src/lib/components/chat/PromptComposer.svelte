<script lang="ts">
	import { onMount, onDestroy, tick, untrack } from 'svelte';
	import FileMentionMenu from './FileMentionMenu.svelte';
	import SlashCommandMenu from './SlashCommandMenu.svelte';
	import ComposerBottomBar from './ComposerBottomBar.svelte';
	import ComposerResizeHandle from './ComposerResizeHandle.svelte';
	import PromptComposerEditor from './PromptComposerEditor.svelte';
	import ComposerSnippetPalette from './ComposerSnippetPalette.svelte';
	import AgentSettingsControls from './AgentSettingsControls.svelte';
	import {
		getComposerState,
		getLocalSettings,
		getChatSessions,
		getAppShell,
		getModelCatalog,
		getAgentState,
		getRemoteSettings,
		getNotifications,
		getSnippets,
		getTransientLayers,
		getWorkspaceShortcuts,
	} from '$lib/context';
	import {
		chatAttachmentAccept,
		ImageAttachmentState,
		isImageAttachment,
		isVideoChatAttachment,
	} from '$lib/chat/composer/image-attachment.svelte.js';
	import {
		resolveComposerKeydownAction,
		canSubmitComposer,
		type ComposerEnterAction,
	} from '$lib/chat/composer/composer-shortcuts.js';
	import type { SnippetInsertionResult } from '$lib/chat/composer/snippet-insertion.js';
	import { applySnippetTriggerReplacement } from '$lib/chat/composer/snippet-trigger.js';
	import { isChatProcessing } from '$lib/chat/sessions/chat-processing.js';
	import { PromptComposerUiState } from './prompt-composer-state.svelte';
	import {
		COMPOSER_DEFAULT_HEIGHT,
		COMPOSER_MAX_HEIGHT,
		COMPOSER_MIN_HEIGHT,
		PromptComposerHeightState,
	} from './prompt-composer-height-state.svelte.js';
	import {
		buildPermissionOptions,
		buildThinkingOptions,
	} from '$lib/chat/composer/composer-controls.js';
	import {
		CHAT_DOCK_SHELL_BASE_CLASS,
		CHAT_DOCK_SURFACE_CLASS,
		CHAT_MAX_WIDTH_COMPOSER_SPACING_CLASS,
		CHAT_MAX_WIDTH_DOCK_FRAME_CLASS,
		CHAT_MAX_WIDTH_DOCK_SHELL_CLASS,
	} from '$lib/chat/conversation/chat-max-width.js';
	import { applyFileMention, findFileMentionTrigger } from '$lib/chat/composer/file-mentions.js';
	import {
		applySlashCommand,
		findSlashCommandTrigger,
		parseSnippetCommand,
		type SnippetCommandParseResult,
	} from '$lib/chat/composer/slash-commands.js';
	import { SnippetExpansionController } from '$lib/snippets/snippet-expansion-controller.svelte.js';
	import { ApiError } from '$lib/api/client.js';
	import { cn } from '$lib/utils/cn';
	import * as m from '$lib/paraglide/messages.js';
	import {
		getLocalStorageItem,
		LOCAL_STORAGE_KEYS,
		setLocalStorageItem,
	} from '$lib/utils/local-persistence';
	import FileText from '@lucide/svelte/icons/file-text';
	import FileVideo from '@lucide/svelte/icons/file-video';
	import { CHAT_FILE_ATTACHMENT_MIME_TYPES } from '@garcon/common/attachments';
	import ImagePlus from '@lucide/svelte/icons/image-plus';
	import X from '@lucide/svelte/icons/x';
	import type { PermissionMode, ThinkingMode } from '$lib/types/chat';
	import type { AgentSettingDescriptor } from '$shared/agent-integration';
	import type { JsonValue } from '$shared/json';
	import type { ResendCandidate } from '$shared/chat-view';
	import ComposerModelSelector from '$lib/components/model-selector/ComposerModelSelector.svelte';
	import { composerModelSelectorMode } from '$lib/components/model-selector/composer-model-selector-mode';
	import { buildModelSelectorRecents } from '$lib/components/model-selector/model-selector-recents';
	import type {
		ModelSelectorChange,
		ModelSelectorMode,
	} from '$lib/components/model-selector/model-selector-types';
	import {
		snippetTemplateUsesArguments,
		type Snippet,
		type SnippetExpansionContext,
	} from '$shared/snippets';
	import { transientLayerAttachment } from '$lib/workspace/transient-layer-action.js';
	import { allocateTransientLayerId } from '$lib/workspace/transient-layer-id.js';
	import { isDirectAgentId, nonDirectAgentIds } from '$lib/agents/direct-agents.js';
	import ResendCandidateChips from './ResendCandidateChips.svelte';
	import { PromptComposerAttachmentController } from './prompt-composer-attachment-controller.js';
	import { PromptComposerRefinementController } from './prompt-composer-refinement-controller.js';
	import { PromptComposerFocusDelivery } from './prompt-composer-focus-delivery.svelte.js';
	interface Props {
		onsubmit: () => void;
		onSteerPreferredSubmit: () => void;
		onModelChange?: (selection: ModelSelectorChange) => void;
		onPermissionModeChange?: (mode: PermissionMode) => void;
		onThinkingModeChange?: (mode: ThinkingMode) => void;
		onAgentSettingChange?: (descriptor: AgentSettingDescriptor, value: JsonValue) => void;
		resendCandidates?: readonly ResendCandidate[];
		onExcludeResendCandidate?: (ordinal: number) => void;
		directAdmissionPending?: boolean;
		// False when the composer is mounted but hidden (e.g. the Git tab is
		// active). Focus requests must not be consumed while hidden, since
		// focusing a display:none textarea is a silent no-op.
		isVisible?: boolean;
		isPresented?: boolean;
		composerEditorOpenRequestId?: number;
	}

	let {
		onsubmit,
		onSteerPreferredSubmit,
		onModelChange,
		onPermissionModeChange,
		onThinkingModeChange,
		onAgentSettingChange,
		resendCandidates = [],
		onExcludeResendCandidate,
		directAdmissionPending = false,
		isVisible = true,
		isPresented: isPresentedOverride,
		composerEditorOpenRequestId = 0,
	}: Props = $props();
	const isPresented = $derived(isPresentedOverride ?? isVisible);
	const composerState = getComposerState();
	const agentState = getAgentState();
	const localSettings = getLocalSettings();
	const sessions = getChatSessions();
	const appShell = getAppShell();
	const modelCatalog = getModelCatalog();
	const remoteSettings = getRemoteSettings();
	const notifications = getNotifications();
	const snippets = getSnippets();
	const transientLayers = getTransientLayers();
	const workspaceShortcuts = getWorkspaceShortcuts();
	const snippetExpansion = new SnippetExpansionController();
	const snippetExpansionLayer = transientLayerAttachment({
		registry: transientLayers,
		id: allocateTransientLayerId('snippet-expansion'),
		kind: 'prompt-transform',
		modality: 'nonmodal',
		onEscape: () => {
			snippetExpansion.cancel();
			return true;
		},
		restoreFocus: returnComposerFocus,
	});

	let textarea: HTMLTextAreaElement | undefined = $state();
	let expandedEditor: { open: () => boolean } | undefined = $state();
	let destroyed = false;
	let fileMentionMenu: { handleKeyDown: (event: KeyboardEvent) => boolean } | undefined = $state();
	let slashCommandMenu: { handleKeyDown: (event: KeyboardEvent) => boolean } | undefined = $state();
	let handledAppShellFocusRequestId = 0;
	let handledDraftAppendRequestId = 0;
	const focusDelivery = new PromptComposerFocusDelivery();
	const snippetInteractionKey = $derived.by(() => {
		const chat = sessions.selectedChat;
		return chat
			? [chat.id, chat.status, chat.projectPath, chat.effectiveProjectKey].join('\u0000')
			: '';
	});
	const snippetContextHint = $derived(
		sessions.selectedChat?.projectPath.trim() ? null : m.snippets_palette_context_hint(),
	);

	function requestComposerFocusForChat(chatId: string | null): void {
		focusDelivery.request(
			chatId,
			untrack(() => workspaceShortcuts.userInteractionGeneration),
		);
	}

	// Auto-focus textarea when the composer mounts (new chat or chat switch).
	onMount(() => {
		tick().then(() => requestComposerFocusForChat(sessions.selectedChatId));
	});

	// Ephemeral UI state extracted to companion class.
	const ui = new PromptComposerUiState();
	const promptRefinement = new PromptComposerRefinementController({
		composer: composerState,
		sessions,
		notifications,
		ui,
		transientLayers,
		get textarea() {
			return textarea;
		},
		get visible() {
			return isVisible;
		},
		get presented() {
			return isPresented;
		},
		get startBlocked() {
			return isDisabled || directAdmissionPending || snippetExpansion.pending;
		},
		resizeTextarea: autoResize,
	});
	const promptTransformPending = $derived(snippetExpansion.pending || promptRefinement.pending);
	const attachmentController = new PromptComposerAttachmentController({
		composer: composerState,
		get attachmentInputBlocked() {
			return promptRefinement.pending;
		},
		get attachmentPickerBlocked() {
			return promptTransformPending;
		},
		get attachmentSupport() {
			return attachmentSupport;
		},
		onAttachmentInput: () => snippetExpansion.cancel(),
	});
	ui.previousChatId = sessions.selectedChatId;
	let previousSnippetProjectPath = sessions.selectedChat?.projectPath ?? null;
	// Resets ephemeral UI state when switching chats without remounting the composer.
	$effect(() => {
		const chatId = sessions.selectedChatId;
		const changed = ui.resetOnChatSwitch(chatId);
		if (!changed) return;
		snippetExpansion.cancel();
		promptRefinement.abort();
		composerState.isDragActive = false;
		requestComposerFocusForChat(chatId);
	});

	// Cancels path-bound expansion when a selected chat moves to another project.
	$effect(() => {
		const projectPath = sessions.selectedChat?.projectPath ?? null;
		if (projectPath === previousSnippetProjectPath) return;
		previousSnippetProjectPath = projectPath;
		snippetExpansion.cancel();
	});

	// Keeps shell focus requests durable while navigation changes ownership.
	$effect(() => {
		const requestId = appShell.composerFocusRequestId;
		if (requestId === 0 || requestId === handledAppShellFocusRequestId) return;
		handledAppShellFocusRequestId = requestId;
		untrack(() => requestComposerFocusForChat(sessions.selectedChatId));
	});

	// Keeps focus pending through transient visibility during window moves.
	$effect(() =>
		focusDelivery.deliver({
			selectedChatId: sessions.selectedChatId,
			disabled: isDisabled,
			visible: isVisible,
			textarea,
			userInteractionGeneration: () => workspaceShortcuts.userInteractionGeneration,
			resize: autoResize,
		}),
	);

	// Shared image URL lifecycle management. Syncs blob URLs with
	// composerState.images and revokes stale URLs automatically.
	const imageAttachments = new ImageAttachmentState();

	$effect(() => {
		const images = composerState.images;
		untrack(() => {
			const currentImages = imageAttachments.images;
			const unchanged =
				images.length === currentImages.length &&
				images.every((file, index) => file === currentImages[index]);
			if (unchanged) return;
			imageAttachments.images = images;
			imageAttachments.syncUrls();
		});
	});

	onDestroy(() => {
		destroyed = true;
		snippetExpansion.cancel();
		promptRefinement.destroy();
		imageAttachments.revokeAll();
	});

	const composerHeight = new PromptComposerHeightState();

	function autoResize(): void {
		if (!textarea || !isVisible) return;
		composerHeight.fitToContent(textarea, appShell.isMobile);
	}

	// Programmatic draft changes do not emit input events. The effect measures
	// the updated DOM value while Svelte remains the sole owner of its height.
	$effect(() => {
		const target = textarea;
		const inputText = composerState.inputText;
		const mobile = appShell.isMobile;
		const visible = isVisible;
		if (!target || !visible || target.value !== inputText) return;
		untrack(() => composerHeight.fitToContent(target, mobile));
	});

	onMount(() => {
		const stored = getLocalStorageItem(LOCAL_STORAGE_KEYS.composerHeight);
		if (stored === null || stored.trim() === '') return;
		const parsed = Number(stored);
		if (!Number.isFinite(parsed)) return;
		composerHeight.restorePreferredHeight(parsed);
		if (appShell.isMobile) autoResize();
	});

	function commitComposerHeight(height: number): void {
		const committedHeight = composerHeight.commit(height);
		setLocalStorageItem(LOCAL_STORAGE_KEYS.composerHeight, String(Math.round(committedHeight)));
	}

	// Reveals blocks appended from another surface without moving focus away from that surface.
	$effect(() => {
		const request = composerState.draftAppendRequest;
		const selectedChatId = sessions.selectedChatId;
		const target = textarea;
		const visible = isVisible;
		if (
			!request ||
			request.requestId === handledDraftAppendRequestId ||
			request.chatId !== selectedChatId ||
			!target ||
			!visible
		) {
			return;
		}
		const frameId = requestAnimationFrame(() => {
			if (
				composerState.draftAppendRequest?.requestId !== request.requestId ||
				sessions.selectedChatId !== request.chatId ||
				!textarea ||
				!isVisible
			) {
				return;
			}
			autoResize();
			textarea.scrollTop = textarea.scrollHeight;
			handledDraftAppendRequestId = request.requestId;
		});
		return () => cancelAnimationFrame(frameId);
	});

	function queueCurrentDraft(text: string): void {
		const chatId = sessions.selectedChatId;
		if (chatId) composerState.queueDraftSave(chatId, text);
	}

	async function insertSlashCommand(name: string) {
		if (promptTransformPending) return;
		const trigger =
			ui.slashCommandTrigger ??
			findSlashCommandTrigger(
				composerState.inputText,
				textarea?.selectionStart ?? composerState.inputText.length,
			);
		if (!trigger) {
			ui.closeSlashMenu();
			return;
		}
		const replacement = applySlashCommand(composerState.inputText, trigger, name);
		composerState.inputText = replacement.text;
		queueCurrentDraft(replacement.text);
		ui.closeSlashMenu();
		await tick();
		textarea?.focus();
		textarea?.setSelectionRange(replacement.caret, replacement.caret);
		autoResize();
	}

	async function insertFileMention(path: string) {
		if (promptTransformPending) return;
		const trigger =
			ui.fileMentionTrigger ??
			findFileMentionTrigger(
				composerState.inputText,
				textarea?.selectionStart ?? composerState.inputText.length,
			);
		if (!trigger) {
			ui.closeFileMenu();
			return;
		}
		const replacement = applyFileMention(composerState.inputText, trigger, path);
		composerState.inputText = replacement.text;
		queueCurrentDraft(replacement.text);
		ui.closeFileMenu();
		await tick();
		textarea?.focus();
		textarea?.setSelectionRange(replacement.caret, replacement.caret);
		autoResize();
	}

	function snippetContext(): SnippetExpansionContext | null {
		const chat = sessions.selectedChat;
		const projectPath = chat?.projectPath.trim();
		if (!chat || !projectPath) return null;
		return chat.status === 'draft'
			? { type: 'new-chat', chatId: chat.id, projectPath }
			: { type: 'chat', chatId: chat.id };
	}

	function snippetErrorDetail(error: unknown): string {
		if (error instanceof ApiError) return error.details || error.message;
		return error instanceof Error ? error.message : String(error);
	}

	function returnComposerFocus(): void {
		if (destroyed || !isVisible) return;
		textarea?.focus({ preventScroll: true });
	}

	async function settleComposerAfterSnippet(caret?: number): Promise<void> {
		await tick();
		if (destroyed || !isVisible) return;
		if (caret !== undefined) textarea?.setSelectionRange(caret, caret);
		autoResize();
	}

	async function insertSnippet(
		snippet: Snippet,
		argumentsText: string,
		range: { start: number; end: number } | null = null,
	): Promise<SnippetInsertionResult> {
		if (promptTransformPending || !textarea) return 'cancelled';
		ui.closeSlashMenu();
		ui.closeFileMenu();
		composerState.isDragActive = false;
		const context = snippetContext();
		if (!context) {
			notifications.error(m.chat_new_chat_errors_project_path_required());
			await settleComposerAfterSnippet();
			return 'cancelled';
		}
		const chatId = sessions.selectedChatId;
		const projectPath = sessions.selectedChat?.projectPath.trim() ?? null;
		const sourceText = composerState.inputText;
		const start = range?.start ?? textarea.selectionStart;
		const end = range?.end ?? textarea.selectionEnd;
		try {
			const result = await snippetExpansion.run({
				shortName: snippet.shortName,
				arguments: { type: 'value', value: argumentsText },
				context,
			});
			if (result.kind !== 'expanded') return 'cancelled';
			if (
				result.response.snippetId !== snippet.id ||
				result.response.snippetUpdatedAt !== snippet.updatedAt
			) {
				void snippets.refreshIfLoaded();
				notifications.error(m.snippets_changed_before_expansion());
				await settleComposerAfterSnippet();
				return 'cancelled';
			}
			if (
				sessions.selectedChatId !== chatId ||
				sessions.selectedChat?.projectPath.trim() !== projectPath ||
				result.response.contextProjectPath !== projectPath ||
				composerState.inputText !== sourceText
			)
				return 'cancelled';
			const replacement = range
				? applySnippetTriggerReplacement(sourceText, range, result.response.expandedText)
				: {
						text: sourceText.slice(0, start) + result.response.expandedText + sourceText.slice(end),
						caret: start + result.response.expandedText.length,
					};
			composerState.inputText = replacement.text;
			queueCurrentDraft(replacement.text);
			await settleComposerAfterSnippet(replacement.caret);
			return 'inserted';
		} catch (error) {
			if (error instanceof ApiError && error.status === 404) void snippets.refreshIfLoaded();
			notifications.error(m.snippets_expand_error({ detail: snippetErrorDetail(error) }));
			await settleComposerAfterSnippet();
			return 'failed';
		}
	}

	async function expandSnippetInvocation(
		command: Extract<SnippetCommandParseResult, { kind: 'valid' }>,
	): Promise<void> {
		const context = snippetContext();
		if (!context) {
			notifications.error(m.chat_new_chat_errors_project_path_required());
			return;
		}
		const chatId = sessions.selectedChatId;
		const projectPath = sessions.selectedChat?.projectPath.trim() ?? null;
		const sourceText = composerState.inputText;
		ui.closeSlashMenu();
		ui.closeFileMenu();
		composerState.isDragActive = false;
		try {
			const result = await snippetExpansion.run({
				shortName: command.shortName,
				arguments: command.arguments,
				context,
			});
			if (result.kind !== 'expanded') return;
			if (
				sessions.selectedChatId !== chatId ||
				sessions.selectedChat?.projectPath.trim() !== projectPath ||
				result.response.contextProjectPath !== projectPath ||
				composerState.inputText !== sourceText
			)
				return;
			composerState.inputText = result.response.expandedText;
			queueCurrentDraft(result.response.expandedText);
			ui.closeSlashMenu();
			await settleComposerAfterSnippet(result.response.expandedText.length);
		} catch (error) {
			if (error instanceof ApiError && error.status === 404) void snippets.refreshIfLoaded();
			notifications.error(m.snippets_expand_error({ detail: snippetErrorDetail(error) }));
			await settleComposerAfterSnippet();
		}
	}

	function editSnippets(): void {
		appShell.openSnippets(() => appShell.requestComposerFocus());
	}

	function handleCompletionKeyDown(event: KeyboardEvent): boolean {
		if (!ui.showFileMenu && !ui.showSlashMenu) return false;
		const menu = ui.showFileMenu ? fileMentionMenu : slashCommandMenu;
		if (menu?.handleKeyDown(event)) return true;
		if (!['ArrowDown', 'ArrowUp', 'Enter', 'Tab'].includes(event.key)) return false;
		event.preventDefault();
		return true;
	}

	function resolveKeydownAction(event: KeyboardEvent): ComposerEnterAction {
		return resolveComposerKeydownAction(event, {
			sendByShiftEnter: localSettings.sendByShiftEnter,
			steerWithCtrlEnter: localSettings.steerWithCtrlEnter,
			isMobile: appShell.isMobile,
		});
	}

	function handleKeyDown(event: KeyboardEvent) {
		if (promptTransformPending) {
			if (event.key === 'Enter' && resolveKeydownAction(event) !== 'newline') {
				event.preventDefault();
			}
			return;
		}
		if (handleCompletionKeyDown(event)) return;
		if (event.key !== 'Enter') return;
		const action = resolveKeydownAction(event);
		if (action === 'newline') return;

		event.preventDefault();
		handleFormSubmit(action);
	}

	function handleFormSubmit(action: Exclude<ComposerEnterAction, 'newline'> = 'submit') {
		if (!canSubmit || promptTransformPending) return;
		const command = parseSnippetCommand(composerState.inputText);
		if (command.kind === 'invalid') {
			notifications.error(
				command.error === 'short-name-required'
					? m.snippets_command_name_required()
					: m.snippets_command_name_invalid(),
			);
			return;
		}
		if (command.kind === 'valid') {
			returnComposerFocus();
			void expandSnippetInvocation(command);
			return;
		}
		if (action === 'steer-preferred') onSteerPreferredSubmit();
		else onsubmit();
	}

	function handleInput(event: Event) {
		const target = event.currentTarget as HTMLTextAreaElement;
		if (isDisabled || promptRefinement.pending) {
			target.value = composerState.inputText;
			return;
		}
		if (snippetExpansion.pending) snippetExpansion.cancel();
		const value = target.value;
		composerState.inputText = value;
		autoResize();
		const caret = textarea?.selectionStart ?? value.length;
		ui.updateTriggers(
			value,
			caret,
			localSettings.snippetTrigger,
			(event as InputEvent).isComposing,
		);
		queueCurrentDraft(value);
	}

	const selectedIsProcessing = $derived(isChatProcessing(sessions.selectedChat));
	const thinkingReducedMotion = $derived(selectedIsProcessing && localSettings.reduceMotion);
	const capabilityAgentId = $derived(sessions.selectedChat?.agentId ?? agentState.agentId);
	const isDraftStartupSubmitting = $derived(
		composerState.isSubmitting && sessions.selectedChat?.status === 'draft',
	);
	const isQueueMode = $derived(selectedIsProcessing);
	const isDisabled = $derived(isDraftStartupSubmitting);

	const canSubmit = $derived(
		canSubmitComposer(
			isDisabled || directAdmissionPending || promptTransformPending,
			composerState.inputText,
			composerState.images.length,
		),
	);
	const promptTransformStatus = $derived(
		promptRefinement.pending ? m.chat_composer_refining_prompt() : m.snippets_expanding(),
	);
	const permissionOptions = $derived(
		buildPermissionOptions(modelCatalog.getPermissionModes(agentState.agentId)),
	);
	const thinkingOptions = $derived(
		buildThinkingOptions(modelCatalog.getThinkingModes(agentState.agentId), agentState.model),
	);
	const canAttachImages = $derived(
		modelCatalog.supportsImages(agentState.agentId, agentState.model),
	);
	const fileAttachmentMimeTypes = $derived(
		modelCatalog.fileAttachmentMimeTypes?.(agentState.agentId) ?? CHAT_FILE_ATTACHMENT_MIME_TYPES,
	);
	const attachmentSupport = $derived({
		allowImages: canAttachImages,
		fileMimeTypes: fileAttachmentMimeTypes,
	});
	const canAttachAttachments = $derived(canAttachImages || fileAttachmentMimeTypes.length > 0);
	const attachmentAccept = $derived(chatAttachmentAccept(attachmentSupport));
	// Existing (already-started) chats expose the full agent/source picker so a
	// conversation can move between configured providers and models. Drafts keep
	// the compact trigger; the new-chat form owns agent selection before start.
	const isActiveModelSelection = $derived(
		Boolean(sessions.selectedChat) && sessions.selectedChat?.status !== 'draft',
	);
	const modelSelectorAgentIds = $derived.by(() => {
		const allAgentIds = modelCatalog.getSelectableAgents();
		const selectedAgentId = sessions.selectedChat?.agentId;
		if (localSettings.allowDirectChats || (selectedAgentId && isDirectAgentId(selectedAgentId))) {
			return allAgentIds;
		}
		return nonDirectAgentIds(allAgentIds);
	});
	const modelSelectorMode: ModelSelectorMode = $derived(
		isActiveModelSelection
			? composerModelSelectorMode(modelCatalog, agentState.agentId, modelSelectorAgentIds)
			: { agent: 'fixed', source: 'hidden', surface: 'composer' },
	);
	const modelSelectorValue = $derived({
		agentId: agentState.agentId,
		model: agentState.model,
		apiProviderId: agentState.apiProviderId,
		modelEndpointId: agentState.modelEndpointId,
		modelProtocol: agentState.modelProtocol,
	});
	const recentSelectorOptions = $derived.by(() =>
		buildModelSelectorRecents(modelCatalog, remoteSettings.snapshot?.recentAgentSettings ?? []),
	);
	const preferRecentsOnOpen = $derived(recentSelectorOptions.length > 1);
	const sendButtonClass =
		'bg-primary text-primary-foreground border-primary/30 hover:bg-primary/90';
	const composerShellClass = $derived(
		cn(
			CHAT_DOCK_SHELL_BASE_CLASS,
			CHAT_MAX_WIDTH_DOCK_SHELL_CLASS[localSettings.chatMaxWidth],
			CHAT_MAX_WIDTH_COMPOSER_SPACING_CLASS[localSettings.chatMaxWidth],
		),
	);
	const composerFrameWrapperClass = $derived(
		cn('w-full', CHAT_MAX_WIDTH_DOCK_FRAME_CLASS[localSettings.chatMaxWidth]),
	);
	const composerSurfaceClass = cn('relative z-20', CHAT_DOCK_SURFACE_CLASS, 'shadow-none');
	const imageListClass = $derived(cn('p-2 bg-muted/40 rounded-lg mx-2 mt-2'));
	const textareaClass = $derived(
		cn(
			'block w-full bg-transparent outline-none focus-visible:ring-2 focus-visible:ring-ring text-foreground placeholder:text-muted-foreground disabled:opacity-50 resize-none max-h-[40vh] sm:max-h-[500px] overflow-y-auto text-base leading-6 transition-colors duration-200',
			'px-4 py-2.5 sm:px-5 sm:py-4 min-h-[48px]',
		),
	);
</script>

{#snippet composerSurface()}
	<div
		data-composer
		class={composerSurfaceClass}
		aria-busy={promptTransformPending}
		{@attach snippetExpansion.pending && snippetExpansionLayer}
		{@attach promptRefinement.pending &&
			!ui.composerEditorOpen &&
			isPresented &&
			promptRefinement.layerAttachment}
	>
		<FileMentionMenu
			bind:this={fileMentionMenu}
			projectPath={sessions.selectedChat?.projectPath || ''}
			isVisible={ui.showFileMenu}
			query={ui.fileQuery}
			onSelect={insertFileMention}
			onClose={() => ui.closeFileMenu()}
		/>

		<ComposerSnippetPalette
			open={ui.snippetPalette.isOpen}
			onOpenChange={(nextOpen) => {
				// The hidden trigger remains available to the chained insertion.
				if (!nextOpen) ui.snippetPalette.hide();
			}}
			initialQuery={ui.snippetPalette.initialQuery}
			interactionKey={snippetInteractionKey}
			contextHint={snippetContextHint}
			onInsert={async (snippet, argumentsText) => {
				const trigger = ui.snippetPalette.trigger;
				const result = await insertSnippet(snippet, argumentsText, trigger);
				if (result === 'inserted') ui.snippetPalette.complete();
				else if (result !== 'failed' || !snippetTemplateUsesArguments(snippet.template)) {
					ui.snippetPalette.dismiss();
				}
				return result;
			}}
			onCancelled={() => {
				const caret = ui.snippetPalette.trigger?.end;
				ui.snippetPalette.dismiss();
				void settleComposerAfterSnippet(caret);
			}}
			onReturnFocus={returnComposerFocus}
			onEditSnippets={() => {
				ui.snippetPalette.dismiss();
				editSnippets();
			}}
		/>

		<form
			onsubmit={(e) => {
				e.preventDefault();
				handleFormSubmit();
			}}
			class="relative"
		>
				{#if !selectedIsProcessing}
					<ResendCandidateChips
						candidates={resendCandidates}
						onExclude={(ordinal) => onExcludeResendCandidate?.(ordinal)}
				/>
			{/if}
			{#if composerState.isDragActive}
				<div
					class="absolute inset-0 bg-primary/20 border-2 border-dashed border-primary flex items-center justify-center z-50 rounded-lg"
				>
					<div class="bg-card rounded-lg p-4 shadow-md">
						<ImagePlus class="w-8 h-8 text-primary mx-auto mb-2" />
						<p class="text-sm font-medium text-foreground">{m.chat_composer_drop_images()}</p>
					</div>
				</div>
			{/if}

			{#if composerState.images.length > 0}
				<div class={imageListClass}>
					<div class="flex flex-wrap gap-2">
						{#each composerState.images as file, idx (file.name + idx)}
							<div class="relative group">
								<div class="w-16 h-16 rounded-lg overflow-hidden border border-border">
									{#if isImageAttachment(file)}
										{@const url = imageAttachments.urlFor(file, idx)}
										{#if url}
											<img src={url} alt={file.name} class="w-full h-full object-cover" />
										{/if}
									{:else}
										<div
											class="flex h-full w-full flex-col items-center justify-center gap-1 bg-background px-1 text-muted-foreground"
										>
											{#if isVideoChatAttachment(file)}
												<FileVideo class="h-5 w-5" aria-hidden="true" />
											{:else}
												<FileText class="h-5 w-5" aria-hidden="true" />
											{/if}
											<span class="w-full truncate text-center text-[10px] leading-tight"
												>{file.name}</span
											>
										</div>
									{/if}
								</div>
								<button
									type="button"
									aria-label={m.chat_composer_remove_image({ name: file.name })}
									title={m.chat_composer_remove_image({ name: file.name })}
									class="absolute -top-1 -right-1 w-5 h-5 bg-destructive text-destructive-foreground rounded-full text-xs flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
									onclick={() => {
										if (!promptTransformPending) composerState.removeImage(idx);
									}}
									disabled={promptTransformPending}
								>
									<X class="w-3 h-3" aria-hidden="true" />
								</button>
							</div>
						{/each}
					</div>
				</div>
			{/if}

			<input
				bind:this={attachmentController.fileInput}
				type="file"
				accept={attachmentAccept}
				multiple
				disabled={promptTransformPending}
				class="hidden"
				onchange={(event) => attachmentController.handleFileChange(event)}
			/>

			<!-- svelte-ignore a11y_no_static_element_interactions -- labeled region accepts native file drops; follow-up: CLEANUP_ROUND_TWO.md#a11y-suppression-register -->
			<div
				class="relative overflow-hidden bg-transparent focus-within:ring-0"
				ondragover={(event) => attachmentController.handleDragOver(event)}
				ondragleave={() => attachmentController.handleDragLeave()}
				ondrop={(event) => attachmentController.handleDrop(event)}
				role="region"
				aria-label={m.chat_composer_message_input_area()}
			>
				<div class="relative z-10">
					<textarea
						bind:this={textarea}
						value={composerState.inputText}
						onkeydown={handleKeyDown}
						oninput={handleInput}
						onpaste={(event) => attachmentController.handlePaste(event)}
						onfocus={() => appShell.requestSidebarRecenterToSelected()}
						placeholder={m.chat_composer_reply_placeholder()}
						disabled={isDisabled}
						readonly={promptRefinement.pending}
						aria-busy={promptTransformPending}
						class={textareaClass}
						style:height={`${composerHeight.renderedHeight}px`}></textarea>
				</div>
			</div>

			<ComposerBottomBar
				canAttachImages={canAttachAttachments}
				attachImagesTooltip={m.chat_composer_image_attachments_unavailable()}
				onAddImage={() => attachmentController.pick()}
				onOpenSnippetPalette={() => ui.snippetPalette.openFromMenu()}
				onOpenExpandedEditor={() => expandedEditor?.open()}
				onRefinePrompt={() => promptRefinement.handleAction()}
				canRefinePrompt={promptRefinement.canStart}
				isPromptRefinementPending={promptRefinement.pending}
				addMenuDisabled={isDisabled}
				isPromptTransformPending={promptTransformPending}
				{promptTransformStatus}
				{permissionOptions}
				selectedPermission={agentState.permissionMode}
				onPermissionSelect={(mode) => {
					agentState.permissionMode = mode;
					onPermissionModeChange?.(mode);
				}}
				{thinkingOptions}
				selectedThinking={agentState.thinkingMode}
				onThinkingSelect={(mode) => {
					agentState.thinkingMode = mode;
					onThinkingModeChange?.(mode);
				}}
				canSend={canSubmit}
				onSend={() => handleFormSubmit()}
				sendTitle={isQueueMode ? m.chat_composer_queue_message() : m.chat_composer_send_message()}
				{sendButtonClass}
			>
				{#snippet agentSettings()}
					<AgentSettingsControls
						descriptors={modelCatalog.getAgentSettingsDescriptors(agentState.agentId)}
						envelope={agentState.agentSettings}
						onChange={(descriptor, value) => onAgentSettingChange?.(descriptor, value)}
						disabled={!onAgentSettingChange}
					/>
				{/snippet}
				{#snippet modelSelector()}
					<ComposerModelSelector
						value={modelSelectorValue}
						mode={modelSelectorMode}
						onChange={(next) => onModelChange?.(next)}
						recents={recentSelectorOptions}
						{preferRecentsOnOpen}
						selectableAgentIds={modelSelectorAgentIds}
						align="end"
						side="top"
					/>
				{/snippet}
			</ComposerBottomBar>
		</form>
	</div>
{/snippet}

{#snippet composerFrame()}
	<!-- The processing classes keep the composer and loading tray borders synchronized. -->
	<div
		class="relative"
		class:composer-thinking-active={selectedIsProcessing}
		class:composer-reduce-motion={thinkingReducedMotion}
	>
		<!-- Rendered outside the composer surface, which clips with overflow-hidden,
		     so the upward-opening menu is not cut off. -->
		<SlashCommandMenu
			bind:this={slashCommandMenu}
			agent={agentState.agentId}
			projectPath={sessions.selectedChat?.projectPath || ''}
			chatId={sessions.selectedChatId}
			isVisible={ui.showSlashMenu}
			query={ui.slashQuery}
			supportsFork={modelCatalog.supportsFork(capabilityAgentId)}
			supportsSteering={modelCatalog.supportsSteering(capabilityAgentId)}
			supportsGoals={modelCatalog.supportsGoals(capabilityAgentId)}
			canScheduleIn={Boolean(sessions.selectedChat && sessions.selectedChat.status !== 'draft')}
			onSelect={insertSlashCommand}
			onClose={() => ui.closeSlashMenu()}
		/>

		{#if !appShell.isMobile}
			<ComposerResizeHandle
				value={composerHeight.renderedHeight}
				minimum={COMPOSER_MIN_HEIGHT}
				maximum={COMPOSER_MAX_HEIGHT}
				label={m.chat_composer_resize()}
				onPreview={(height) => composerHeight.preview(height)}
				onCommit={commitComposerHeight}
				onCancel={() => composerHeight.cancelPreview()}
				onReset={() => commitComposerHeight(COMPOSER_DEFAULT_HEIGHT)}
			/>
		{/if}
		{@render composerSurface()}
	</div>
{/snippet}

<div class={composerShellClass}>
	<div class={composerFrameWrapperClass}>
		{@render composerFrame()}
	</div>
</div>

<PromptComposerEditor
	bind:this={expandedEditor}
	{ui}
	{textarea}
	{isVisible}
	{isPresented}
	{isDisabled}
	{promptTransformPending}
	isPromptRefinementPending={promptRefinement.pending}
	canRefinePrompt={promptRefinement.canStart}
	onRefinePrompt={() => promptRefinement.handleAction()}
	openRequestId={composerEditorOpenRequestId}
	resizeTextarea={autoResize}
/>
