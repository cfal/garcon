<script lang="ts">
	// New-chat form used inside the NewChatDialog. Delegates state management
	// to NewChatFormState and retains only DOM interactions and template logic.

	import { onDestroy, onMount, tick, untrack } from 'svelte';
	import ComposerInputSurface from '../composer/ComposerInputSurface.svelte';
	import { NewChatMarkdownState } from './new-chat-markdown-state.svelte.js';
	import { acceptsMarkdownInput } from '$lib/chat/composer/markdown-input.js';
	import type { NewChatConfig } from '$lib/chat/sessions/chat-session-types.js';
	import type { NewChatDialogSeed } from '$lib/chat/new-chat/new-chat-seed';
	import { NewChatFormState } from '$lib/chat/new-chat/new-chat-form-state.svelte.js';
	import { NewChatPromptDraft } from '$lib/chat/new-chat/new-chat-prompt-draft.js';
	import {
		chatAttachmentAccept,
		hasChatAttachmentSupport,
		isSupportedChatAttachment,
	} from '$lib/chat/composer/image-attachment.svelte.js';
	import { shouldSubmitOnEnter } from '$lib/chat/composer/composer-shortcuts.js';
	import type { SnippetInsertionResult } from '$lib/chat/composer/snippet-insertion.js';
	import {
		findSnippetTrigger,
	} from '$lib/chat/composer/snippet-trigger.js';
	import { newChatToolbarSettings } from './new-chat-toolbar-settings';
	import {
		promptEditorSelectionFromTextarea,
		restorePromptEditorSelection,
		type PromptEditorSelection,
	} from '$lib/prompt-editor/prompt-editor-selection.js';
	import ComposerBottomBar from '../composer/ComposerBottomBar.svelte';
	import PromptEditorDialog from '$lib/components/prompt-editor/PromptEditorDialog.svelte';
	import ComposerAttachmentList from '../composer/ComposerAttachmentList.svelte';
	import ComposerAttachmentBadge from '../composer/ComposerAttachmentBadge.svelte';
	import { chatViewSurfaceId } from '$lib/workspace/surface-types.js';
	import ComposerSnippetPalette from '../composer/ComposerSnippetPalette.svelte';
	import NewChatPreambleControls from '../../preambles/NewChatPreambleControls.svelte';
	import ChatTagEditor from '../ChatTagEditor.svelte';
	import ChatTagToggleButton from '../ChatTagToggleButton.svelte';
	import {
		getLocalSettings,
		getAppShell,
		getNewChatPromptDrafts,
		getModelCatalog,
		getExecutors,
		getRemoteSettings,
		getChatSessions,
		getNotifications,
		getPreambles,
		getSnippets,
		getTransientLayers,
		getWorkspaceLayout,
		getOptionalWorkspaceShortcuts,
	} from '$lib/context';
	import * as m from '$lib/paraglide/messages.js';
	import ProjectPathField from '$lib/components/project-paths/ProjectPathField.svelte';
	import NewChatPinnedPaths from './NewChatPinnedPaths.svelte';
	import GitWorktreePickerModal from '$lib/components/git/GitWorktreePickerModal.svelte';
	import Loader2 from '@lucide/svelte/icons/loader-2';
	import X from '@lucide/svelte/icons/x';
	import { ANY_FILE_ATTACHMENT_MIME_TYPE } from '@garcon/common/attachments';
	import ExecutorSelector from '$lib/components/shared/ExecutorSelector.svelte';
	import type { ModelSelectorChange } from '$lib/components/model-selector/model-selector-types';
	import {
		parseSnippetCommand,
		type SnippetCommandParseResult,
	} from '$lib/chat/composer/slash-commands.js';
	import { SnippetExpansionController } from '$lib/snippets/snippet-expansion-controller.svelte.js';
	import { ChatSnippetInsertionController } from '$lib/chat/composer/chat-snippet-insertion-controller.js';
	import { snippetTemplateUsesArguments, type SnippetArgumentsInput } from '$shared/snippets';
	import type { SelectableSnippet } from '$lib/snippets/selectable-snippet.js';
	import type { ChatId } from '$shared/chat-id';
	import { transientLayerAttachment } from '$lib/workspace/transient-layer-action.js';
	import { allocateTransientLayerId } from '$lib/workspace/transient-layer-id.js';
	import { nonDirectAgentIds } from '$lib/agents/direct-agents.js';
	import { NewChatComposerEditorState } from './new-chat-composer-editor-state.svelte.js';
	import { NewChatPromptRefinementController } from './new-chat-prompt-refinement-controller.js';

	interface Props {
		seed?: NewChatDialogSeed | null;
		onStartChat: (config: NewChatConfig, chatId: ChatId) => void;
		onCancel?: () => void;
	}

	let { seed = null, onStartChat, onCancel }: Props = $props();

	const localSettings = getLocalSettings();
	const appShell = getAppShell();
	const rootModelCatalog = getModelCatalog();
	const executors = getExecutors();
	const remoteSettings = getRemoteSettings();
	const sessions = getChatSessions();
	const notifications = getNotifications();
	const preambles = getPreambles();
	const snippets = getSnippets();
	const transientLayers = getTransientLayers();
	const workspaceLayout = getWorkspaceLayout();
	const workspaceShortcuts = getOptionalWorkspaceShortcuts();
	const newChatSurfaceId = $derived(chatViewSurfaceId(workspaceLayout.defaultWindowId));
	const promptDraft = new NewChatPromptDraft(getNewChatPromptDrafts());
	const form: NewChatFormState = new NewChatFormState({
		modelCatalog: rootModelCatalog,
		executors,
		remoteSettings,
		get selectableAgentIds() {
			return newChatAgentIds;
		},
		promptDraft,
		onWorktreeSelected: () => void tick().then(returnTextareaFocus),
	});
	const modelCatalog = $derived(rootModelCatalog.forExecutor(form.executorId));
	const executionAgent = $derived(modelCatalog.getAgent(form.agentId));
	const conversationInput = $derived(
		Boolean(executionAgent && executionAgent.executionPolicy !== 'literal'),
	);
	const executionKey = $derived(
		JSON.stringify([form.executorId, form.agentId, executionAgent?.executionPolicy]),
	);
	function selectableAgentsForExecutor(executorId: string) {
		const allAgentIds = rootModelCatalog.forExecutor(executorId).getSelectableAgents();
		return localSettings.allowDirectChats ? allAgentIds : nonDirectAgentIds(allAgentIds);
	}
	const newChatAgentIds = $derived(selectableAgentsForExecutor(form.executorId));
	const canAttachImages = $derived(modelCatalog.supportsImages(form.agentId, form.modelValue));
	const fileAttachmentMimeTypes = $derived(
		modelCatalog.fileAttachmentMimeTypes?.(form.agentId) ?? ANY_FILE_ATTACHMENT_MIME_TYPE,
	);
	const attachmentSupport = $derived({
		allowImages: canAttachImages,
		fileMimeTypes: fileAttachmentMimeTypes,
	});
	const canAttachAttachments = $derived(hasChatAttachmentSupport(attachmentSupport));
	const attachmentAccept = $derived(chatAttachmentAccept(attachmentSupport));
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
		restoreFocus: returnTextareaFocus,
	});

	const isMobile = $derived(appShell.isMobile);
	let pendingTextareaFocus = $state(true);
	const initialContentReady = $derived(form.settingsLoaded);
	const allKnownTags = $derived(
		Array.from(new Set(sessions.orderedChats.flatMap((c) => c.tags))).sort(),
	);

	let textareaRef: HTMLTextAreaElement | undefined = $state();
	let imageInputRef: HTMLInputElement | undefined = $state();
	let expansionProjectPath = '';
	let snippetInteractionGeneration = $state(0);
	const snippetInteractionKey = $derived(
		`${snippetInteractionGeneration}\u0000${form.executorId}\u0000${form.nonblankPath}`,
	);

	const markdownState: NewChatMarkdownState = new NewChatMarkdownState({
		form,
		get generation() {
			return snippetInteractionGeneration;
		},
		get textarea() {
			return textareaRef;
		},
		get canFormat() {
			return canFormat;
		},
		get acceptsMarkdown() {
			return acceptsMarkdownInput(executionAgent, form.modelValue);
		},
		get preferredMode() {
			return localSettings.composerInputMode;
		},
		get interactionGeneration() {
			return workspaceShortcuts?.userInteractionGeneration ?? 0;
		},
		get snippetTrigger() {
			return conversationInput ? localSettings.snippetTrigger : '';
		},
		onUnavailable() {
			notifications.error(m.chat_composer_format_unavailable());
		},
	});
	const inputUi = markdownState.ui;
	const markdown = markdownState.controller;
	const snippetPalette = inputUi.snippetPalette;
	const formattedDraft = $derived(markdownState.draft);
	const composerEditor = new NewChatComposerEditorState();
	const promptRefinement = new NewChatPromptRefinementController({
		form,
		notifications,
		transientLayers,
		editor: composerEditor,
		get textarea() {
			return textareaRef;
		},
		get startBlocked() {
			return !initialContentReady || snippetExpansion.pending || inputUi.formattedPastePending;
		},
		closePromptSurfaces: () => {
			snippetPalette.dismiss();
			markdown.reset();
		},
	});
	const canFormat = $derived(
		initialContentReady &&
			!composerEditor.open &&
			!promptRefinement.pending &&
			!snippetExpansion.pending,
	);
	const promptTransformPending = $derived(
		snippetExpansion.pending || promptRefinement.pending || inputUi.formattedPastePending,
	);
	$effect(() => {
		executionKey;
		return () => {
			snippetExpansion.cancel();
			promptRefinement.abort();
		};
	});
	const promptTransformStatus = $derived(
		inputUi.formattedPastePending
			? m.chat_composer_pasting()
			: promptRefinement.pending
				? m.chat_composer_refining_prompt()
				: m.snippets_expanding(),
	);

	function canFocusTextarea(): boolean {
		return (
			!transientLayers.makesMainInert || transientLayers.ownsTopModalTarget(textareaRef ?? null)
		);
	}

	onMount(() => {
		markdown.reset();
		snippetInteractionGeneration += 1;
		form.reseed(seed?.prefill ?? '', seed?.prospectiveChatId);
		if (seed?.startup) form.restoreStartup(seed.startup);
		else if (seed?.project) form.seedProject(seed.project);
		form.loadSettingsAndModels();
	});

	$effect(() => {
		if (!form.executorReady) return;
		const catalog = modelCatalog;
		void catalog.version;
		untrack(() => void catalog.refreshIfStale());
	});

	// Revalidates selected models whenever the shared model catalog updates.
	$effect(() => {
		void modelCatalog.version;
		form.validateAllModelsAgainstLive();
	});

	$effect(() => {
		const selectableAgentIds = newChatAgentIds;
		untrack(() => form.reconcileAgentSelection(selectableAgentIds));
	});

	let pathInput: HTMLInputElement | null = $state(null);

	// Defers initial textarea focus until startup defaults have loaded and the
	// input is visible.
	$effect(() => {
		if (!pendingTextareaFocus || !initialContentReady || form.showBrowser || !canFocusTextarea())
			return;
		if (!textareaRef) return;
		if (seed?.prefill) {
			textareaRef.setSelectionRange(0, 0);
			textareaRef.scrollTop = 0;
		}
		textareaRef.focus();
		pendingTextareaFocus = false;
	});

	// Debounced path validation reacts to path changes.
	const validationTargetKey = $derived(`${form.pathContextKey}\u0000${form.nonblankPath}`);
	$effect(() => {
		const projectPath = validationTargetKey;
		if (projectPath !== expansionProjectPath) {
			expansionProjectPath = projectPath;
			snippetExpansion.cancel();
		}
		untrack(() => form.validateChangedPath());
	});

	onDestroy(() => {
		snippetExpansion.cancel();
		promptRefinement.destroy();
		markdown.destroy();
		form.revokeAllImageUrls();
		form.dispose();
	});

	function openImagePicker(): void {
		if (promptTransformPending) return;
		imageInputRef?.click();
	}

	function handleImageInputChange(event: Event): void {
		const input = event.target as HTMLInputElement;
		if (promptTransformPending) {
			input.value = '';
			return;
		}
		if (!input.files) return;
		form.addImages(Array.from(input.files), attachmentSupport);
		input.value = '';
	}

	function handleMessagePaste(event: ClipboardEvent): void {
		if (promptRefinement.pending) return;
		const items = event.clipboardData?.items;
		if (!items) return;
		const pastedImages: File[] = [];
		for (const item of items) {
			if (item.kind !== 'file') continue;
			const file = item.getAsFile();
			if (file && isSupportedChatAttachment(file, attachmentSupport)) pastedImages.push(file);
		}
		if (pastedImages.length > 0) {
			snippetExpansion.cancel();
			form.addImages(pastedImages, attachmentSupport);
		}
	}

	function handleMessageInput(event: Event): void {
		const input = event.currentTarget as HTMLTextAreaElement;
		if (promptRefinement.pending) {
			input.value = form.firstMessage;
			return;
		}
		if (snippetExpansion.pending) snippetExpansion.cancel();
		form.firstMessage = input.value;
		markdown.input(event as InputEvent);
		if (!conversationInput || (event as InputEvent).isComposing) return;
		snippetPalette.updateDetectedTrigger(
			findSnippetTrigger(input.value, input.selectionStart, localSettings.snippetTrigger),
			input.value,
		);
	}

	function returnTextareaFocus(): void {
		(formattedDraft ? inputUi.formattedTarget : textareaRef)?.focus({ preventScroll: true });
	}

	async function settleTextareaAfterSnippet(caret?: number): Promise<void> {
		await tick();
		if (caret !== undefined) textareaRef?.setSelectionRange(caret, caret);
	}

	function openExpandedEditor(): void {
		if (promptTransformPending || !textareaRef) return;
		if (formattedDraft)
			textareaRef.setSelectionRange(form.firstMessage.length, form.firstMessage.length);
		markdown.reset();
		snippetPalette.dismiss();
		const selection = promptEditorSelectionFromTextarea(textareaRef);
		textareaRef.focus({ preventScroll: true });
		composerEditor.show(selection);
	}

	async function closeExpandedEditor(): Promise<void> {
		const selection = composerEditor.selection;
		composerEditor.close();
		await tick();
		if (!textareaRef) return;
		restorePromptEditorSelection(textareaRef, selection);
		textareaRef.focus({ preventScroll: true });
	}

	function handleExpandedTextChange(text: string): void {
		if (promptTransformPending || !composerEditor.open || form.firstMessage === text) return;
		form.firstMessage = text;
	}

	function handleExpandedSelectionChange(selection: PromptEditorSelection): void {
		composerEditor.updateSelection(selection);
	}

	function expansionContext() {
		const projectPath = form.nonblankPath;
		if (projectPath) {
			return {
				type: 'new-chat' as const,
				chatId: promptDraft.ensureProspectiveChatId(),
				projectPath,
				executorId: form.executorId,
			};
		}
		notifications.error(m.chat_new_chat_errors_project_path_required());
		return null;
	}

	const snippetInsertion = new ChatSnippetInsertionController({
		refreshSnippets: () => snippets.refreshIfLoaded(),
		refreshPreambles: () => preambles.refreshIfLoaded(),
		reportError: message => notifications.error(message),
		settle: settleTextareaAfterSnippet,
	});

	function runSnippet(
		shortName: string,
		argumentsInput: SnippetArgumentsInput,
		context: NonNullable<ReturnType<typeof expansionContext>>,
		insertion?: { snippet: SelectableSnippet; selection: { start: number; end: number };
			trigger: { start: number; end: number } | null },
	): Promise<SnippetInsertionResult> {
		const sourceExecutionKey = executionKey;
		const sourceText = form.firstMessage;
		return snippetInsertion.execute({
			expand: () => snippetExpansion.runPrepared(shortName, () => ({
				request: { shortName, arguments: argumentsInput, context },
				prepared: context,
			})),
			isCurrent: ({ response }) => form.nonblankPath === context.projectPath
				&& response.contextProjectPath === context.projectPath && response.contextExecutorId === form.executorId
				&& (insertion !== undefined || conversationInput)
				&& executionKey === sourceExecutionKey && form.firstMessage === sourceText,
			apply: (text) => {
				form.firstMessage = text;
			},
			insertion: insertion ? { ...insertion, source: sourceText } : undefined,
		});
	}

	async function insertSnippet(
		snippet: SelectableSnippet,
		argumentsText: string,
		range: { start: number; end: number } | null = null,
	): Promise<SnippetInsertionResult> {
		if (promptTransformPending || !textareaRef) return 'cancelled';
		const context = expansionContext();
		if (!context) {
			await settleTextareaAfterSnippet();
			return 'cancelled';
		}
		return runSnippet(snippet.shortName, { type: 'value', value: argumentsText }, context, {
			snippet,
			trigger: range,
			selection: { start: textareaRef.selectionStart, end: textareaRef.selectionEnd },
		});
	}

	async function expandSnippetInvocation(
		command: Extract<SnippetCommandParseResult, { kind: 'valid' }>,
	): Promise<void> {
		if (!conversationInput || promptTransformPending) return;
		const context = expansionContext();
		if (!context) return;
		await runSnippet(command.shortName, command.arguments, context);
	}

	function editSnippets(): void {
		appShell.openSnippets(() => {
			void tick().then(() => textareaRef?.focus());
		});
	}

	function handleSubmit(): void {
		if (!form.canSubmit || promptTransformPending) return;
		const command = conversationInput ? parseSnippetCommand(form.firstMessage) : { kind: 'none' as const };
		if (command.kind === 'invalid') {
			notifications.error(
				command.error === 'short-name-required'
					? m.snippets_command_name_required()
					: m.snippets_command_name_invalid(),
			);
			return;
		}
		if (command.kind === 'valid') {
			returnTextareaFocus();
			void expandSnippetInvocation(command);
			return;
		}
		const config = form.buildConfig();
		if (!config) return;
		const chatId = promptDraft.ensureProspectiveChatId();
		if (sessions.byId[chatId]) {
			form.error = m.chat_new_chat_errors_chat_id_in_use();
			return;
		}
		onStartChat(config, chatId);
		promptDraft.discardSubmitted();
	}

	function shouldSubmitMessageOnEnter(event: KeyboardEvent): boolean {
		return (
			event.key === 'Enter' &&
			shouldSubmitOnEnter({
				sendByShiftEnter: localSettings.sendByShiftEnter,
				shiftKey: event.shiftKey,
				ctrlKey: event.ctrlKey,
				metaKey: event.metaKey,
				isComposing: event.isComposing,
				isMobile,
			})
		);
	}

	function handleKeyDown(e: KeyboardEvent): void {
		const submitOnEnter = shouldSubmitMessageOnEnter(e);
		if (promptTransformPending) {
			if (submitOnEnter) e.preventDefault();
			return;
		}
		if (submitOnEnter) {
			e.preventDefault();
			handleSubmit();
		}
		if (e.key === 'Escape' && onCancel) {
			e.preventDefault();
			e.stopPropagation();
			cancelForm();
		}
	}

	function cancelForm(): void {
		snippetExpansion.cancel();
		promptRefinement.abort();
		composerEditor.close();
		onCancel?.();
	}

	const toolbarSettings = $derived(newChatToolbarSettings({
		form,
		modelCatalog: rootModelCatalog,
		remoteSettings,
		getSelectableAgentIds: selectableAgentsForExecutor,
		onModelChange: handleModelSelectorChange,
	}));
	const displayedFormError = $derived(
		form.modelSelectionError ??
			form.agentSelectionError ??
			form.executionModeError ??
			form.attachmentError ??
			form.error,
	);

	function handleModelSelectorChange(next: ModelSelectorChange): void {
		if (!localSettings.allowDirectChats && nonDirectAgentIds([next.agentId]).length === 0) return;
		if (next.executorId !== form.executorId) return;
		if (!newChatAgentIds.includes(next.agentId)) return;
		form.selectAgent(next.agentId);
		form.selectModel(next.modelValue, next);
	}
</script>

<div
	class="min-w-0 p-2 sm:p-4"
	{@attach snippetExpansion.pending && snippetExpansionLayer}
	{@attach promptRefinement.pending && !composerEditor.open && promptRefinement.layerAttachment}
>
	<div class="relative">
		<div
			data-slot="new-chat-form-content"
			class:invisible={!initialContentReady}
			class:pointer-events-none={!initialContentReady}
			inert={!initialContentReady}
			aria-hidden={!initialContentReady}
		>
			<div class="space-y-2">
				<ProjectPathField
					id="project-path-input"
					aria-label={m.chat_new_chat_project_path()}
					bind:ref={pathInput}
					bind:value={form.projectPath}
					readonly={form.isUpdatingPinnedPath}
					inputmode={isMobile && form.filesAvailable ? 'none' : undefined}
					placeholder={form.projectBasePath}
					class="h-[42px] sm:pointer-fine:h-[38px]"
					validationStatus={form.validationStatus}
					validationError={form.validationError}
					onfocus={(event) => {
						if (isMobile && form.filesAvailable) event.currentTarget.blur();
						if (form.isUpdatingPinnedPath) return;
						form.handlePathFocus();
					}}
					onclick={() => {
						if (isMobile && !form.isUpdatingPinnedPath) form.handlePathFocus();
					}}
					oninput={() => {
						form.clearError();
						form.resetTabCompletions();
					}}
					onkeydown={(event) => {
						if (event.key === 'Tab' && form.filesAvailable) {
							event.preventDefault();
							if (form.isUpdatingPinnedPath) return;
							void form.handleTabCompletion();
						}
						if (event.key === 'Enter') {
							event.preventDefault();
							form.showBrowser = false;
							returnTextareaFocus();
						}
					}}
					pin={{
						isPinned: form.isPinnedPath,
						disabled: !form.nonblankPath || form.isUpdatingPinnedPath,
						loading: form.isUpdatingPinnedPath,
						onToggle: () => form.togglePinnedPath(),
					}}
					browser={{
						open: form.filesAvailable && form.showBrowser && !form.isUpdatingPinnedPath,
						executorId: form.executorId,
						executorContextKey: form.pathContextKey,
						currentPath: form.nonblankPath || form.browseStartPath || form.projectBasePath,
						basePath: form.projectBasePath,
						isMobile,
						onSelect: (path) => {
							if (form.isUpdatingPinnedPath) return;
							// Rechecks a newly created directory even when the field's path is unchanged.
							form.selectProjectPath(path);
						},
						onClose: async (reason) => {
							form.showBrowser = false;
							await tick();
							if (reason === 'select') returnTextareaFocus();
							else pathInput?.focus({ preventScroll: true });
						},
					}}
					feedback={{
						class: '-mt-1',
						error: form.validationStatus === 'invalid' ? form.validationError : null,
						worktree:
							form.gitAvailable && form.gitRepoStatus === 'git'
								? { disabled: form.isUpdatingPinnedPath, onOpen: () => void form.worktreePicker.open() }
								: undefined,
					}}
				>
					{#snippet leading()}
						<ExecutorSelector
							{executors}
							executorId={form.executorId}
							service="agents"
							presentation="field"
							class="h-[42px] w-full sm:pointer-fine:h-[38px] @min-[32rem]/project-target:w-auto @min-[32rem]/project-target:max-w-44"
							onSelect={(executorId) => form.selectExecutor(executorId)}
						/>
					{/snippet}
					<ChatTagToggleButton
						active={form.chatTags.length > 0}
						onToggle={() => form.toggleTagInput()}
					/>
					{#if onCancel}
						<button
							type="button"
							onclick={cancelForm}
							class="px-3 py-2 text-sm border border-border rounded-lg hover:bg-muted/50 transition-colors"
							title={m.editor_actions_close()}
							aria-label={m.editor_actions_close()}
						>
							<X class="w-4 h-4 text-muted-foreground" aria-hidden="true" />
						</button>
					{/if}
				</ProjectPathField>

				<NewChatPinnedPaths {form} onPathSelected={returnTextareaFocus} />

				<ChatTagEditor
					tags={form.chatTags}
					knownTags={allKnownTags}
					open={form.showTagInput}
					onAdd={(raw) => form.addTag(raw)}
					onRemove={(tag) => form.removeTag(tag)}
					onClose={() => (form.showTagInput = false)}
				/>

				{#if conversationInput}
					<NewChatPreambleControls
						selection={form.preambles}
						nonblankPath={form.nonblankPath}
						validationStatus={form.validationStatus}
						onClear={() => form.preambles.setExplicit([])}
					/>
				{/if}

				{#if displayedFormError}
					<div role="status" class="flex items-center gap-2 text-sm text-destructive">
						<span>{displayedFormError}</span>
						{#if form.executorReady && modelCatalog.error}
							<button
								type="button"
								class="text-foreground underline focus-visible:ring-2 focus-visible:ring-ring"
								onclick={() => void modelCatalog.forceRefresh()}>{m.common_retry()}</button
							>
						{/if}
					</div>
				{:else if form.modelSelectionPending}
					<p role="status" class="text-sm text-muted-foreground">{m.chat_composer_loading_models()}</p>
				{/if}
			</div>

			<div
				data-slot="new-chat-composer"
				class="relative mt-3 border border-border rounded-lg [--composer-input-max-height:300px]"
				aria-busy={promptTransformPending}
			>
				<input
					bind:this={imageInputRef}
					type="file"
					accept={attachmentAccept}
					multiple
					disabled={promptTransformPending}
					class="hidden"
					onchange={handleImageInputChange}
				/>
				<ComposerInputSurface
					bind:textarea={textareaRef}
					text={form.firstMessage}
					draft={formattedDraft}
					disabled={false}
					busy={promptTransformPending}
					sourceReadOnly={promptRefinement.pending}
					visible={initialContentReady}
					controller={markdown}
					placeholder={form.placeholder}
					allowFileMentions={false}
					onComposerKeydown={handleKeyDown}
					onCompletionKeydown={() => false}
					onInput={handleMessageInput}
					onPaste={handleMessagePaste}
				/>

				<ComposerBottomBar
					{...toolbarSettings}
					modelControlsLeft={localSettings.modelControlsLeft}
					image={{
						supported: canAttachAttachments,
						unavailableReason: m.chat_composer_image_attachments_unavailable(),
						onSelect: openImagePicker,
					}}
					onOpenSnippetPalette={() => void markdown.openSnippets()}
					onOpenExpandedEditor={openExpandedEditor}
					onRefinePrompt={() => {
						returnTextareaFocus();
						promptRefinement.handleAction();
					}}
					canRefinePrompt={promptRefinement.canStart}
					isPromptRefinementPending={promptRefinement.pending}
					isPromptTransformPending={promptTransformPending}
					{promptTransformStatus}
					send={{ enabled: form.canSubmit, title: m.chat_new_chat_start_session(), onSend: handleSubmit }}
					side="bottom"
				/>

				<ComposerSnippetPalette
					open={snippetPalette.isOpen}
					triggerPrefix={conversationInput ? localSettings.snippetTrigger : ''}
					onOpenChange={(nextOpen) => {
						// The hidden trigger remains available to the chained insertion.
						if (!nextOpen) snippetPalette.hide();
					}}
					initialQuery={snippetPalette.initialQuery}
					interactionKey={snippetInteractionKey}
					contextHint={form.nonblankPath ? null : m.snippets_palette_context_hint()}
					onInsert={async (snippet, argumentsText) => {
						const trigger = snippetPalette.trigger;
						const result = await insertSnippet(snippet, argumentsText, trigger);
						if (result === 'inserted') snippetPalette.complete();
						else if (
							result !== 'failed' ||
							snippet.source !== 'snippet' ||
							!snippetTemplateUsesArguments(snippet.body)
						) {
							snippetPalette.dismiss();
						}
						return result;
					}}
					onCancelled={() => {
						const caret = snippetPalette.trigger?.end;
						snippetPalette.dismiss();
						void settleTextareaAfterSnippet(caret);
					}}
					onReturnFocus={returnTextareaFocus}
					onEditSnippets={() => {
						snippetPalette.dismiss();
						editSnippets();
					}}
				/>
			</div>

			<ComposerAttachmentList
				files={form.attachedImages}
				previewUrls={form.attachmentPreviewUrls}
				disabled={promptTransformPending}
				class="mt-6 p-2 bg-muted/40 rounded-lg"
				onRemove={(index) => form.removeImage(index)}
			/>
		</div>

		{#if !initialContentReady}
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

{#if form.worktreePicker.isOpen}
	<GitWorktreePickerModal session={form.worktreePicker} description={form.firstMessage} />
{/if}

{#if composerEditor.open}
	{#snippet expandedEditorHeaderStatus()}
		<ComposerAttachmentBadge count={form.attachedImages.length} />
	{/snippet}
	<PromptEditorDialog
		title={m.chat_composer_expanded_editor_title()}
		editorLabel={m.chat_composer_expanded_editor_label()}
		text={form.firstMessage}
		selection={composerEditor.selection}
		focusRequestId={composerEditor.focusRequestId}
		readOnly={promptTransformPending}
		surfaceId={newChatSurfaceId}
		headerStatus={expandedEditorHeaderStatus}
		canRefinePrompt={promptRefinement.canStart}
		isPromptRefinementPending={promptRefinement.pending}
		onTextChange={handleExpandedTextChange}
		onSelectionChange={handleExpandedSelectionChange}
		onRefinePrompt={() => promptRefinement.handleAction()}
		onClose={() => void closeExpandedEditor()}
	/>
{/if}
