<script lang="ts">
	import {
		DropdownMenu,
		DropdownMenuContent,
		DropdownMenuItem,
		DropdownMenuTrigger,
	} from '$lib/components/ui/dropdown-menu';
	import type { Snippet as SvelteSnippet } from 'svelte';
	import type { PermissionMode, ThinkingMode } from '$lib/types/chat';
	import type { ComposerModeOption } from '$lib/chat/composer/composer-controls.js';
	import ResponsiveSurfaceActions, {
		type ResponsiveSurfaceAction,
	} from '$lib/components/shared/ResponsiveSurfaceActions.svelte';
	import ComposerModeIcon from './ComposerModeIcon.svelte';
	import Loader2 from '@lucide/svelte/icons/loader-2';
	import Maximize2 from '@lucide/svelte/icons/maximize-2';
	import Sparkles from '@lucide/svelte/icons/sparkles';
	import Square from '@lucide/svelte/icons/square';
	import Send from '@lucide/svelte/icons/send';
	import * as m from '$lib/paraglide/messages.js';
	import ComposerAddMenu from './ComposerAddMenu.svelte';

	interface Props {
		canAttachImages: boolean;
		attachImagesTooltip: string;
		onAddImage: () => void;
		onOpenSnippetPalette?: () => void;
		onOpenExpandedEditor?: () => void;
		onRefinePrompt?: () => void;
		canRefinePrompt?: boolean;
		isPromptRefinementPending?: boolean;
		permissionOptions: ComposerModeOption<PermissionMode>[];
		selectedPermission: PermissionMode;
		onPermissionSelect: (mode: PermissionMode) => void;
		thinkingOptions: ComposerModeOption<ThinkingMode>[];
		selectedThinking: ThinkingMode;
		onThinkingSelect: (mode: ThinkingMode) => void;
		agentSettings?: SvelteSnippet;
		modelSelector?: SvelteSnippet;
		canSend: boolean;
		onSend: () => void;
		sendTitle: string;
		sendButtonClass: string;
		selectorsSide?: 'left' | 'right';
		mobileRightGroupFullRow?: boolean;
		showAddMenu?: boolean;
		showSendButton?: boolean;
		addMenuDisabled?: boolean;
		isPromptTransformPending?: boolean;
		promptTransformStatus?: string;
	}

	let {
		canAttachImages,
		attachImagesTooltip,
		onAddImage,
		onOpenSnippetPalette = () => undefined,
		onOpenExpandedEditor,
		onRefinePrompt,
		canRefinePrompt = false,
		isPromptRefinementPending = false,
		permissionOptions,
		selectedPermission,
		onPermissionSelect,
		thinkingOptions,
		selectedThinking,
		onThinkingSelect,
		agentSettings,
		modelSelector,
		canSend,
		onSend,
		sendTitle,
		sendButtonClass,
		selectorsSide = 'right',
		mobileRightGroupFullRow = false,
		showAddMenu = true,
		showSendButton = true,
		addMenuDisabled = false,
		isPromptTransformPending = false,
		promptTransformStatus = m.snippets_expanding(),
	}: Props = $props();

	const activePermission = $derived(
		permissionOptions.find((option) => option.value === selectedPermission) ?? permissionOptions[0],
	);
	const promptRefinementActionLabel = $derived(
		isPromptRefinementPending ? m.prompt_refinement_cancel() : m.prompt_refinement_refine(),
	);
	const sendActionLabel = $derived(isPromptTransformPending ? promptTransformStatus : sendTitle);
	const activeThinking = $derived(
		thinkingOptions.find((option) => option.value === selectedThinking) ?? thinkingOptions[0],
	);
	const permissionControlLabel = $derived(
		activePermission
			? `${m.chat_composer_permission_mode()}: ${activePermission.label}`
			: m.chat_composer_permission_mode(),
	);
	const thinkingControlLabel = $derived(
		activeThinking
			? `${m.chat_composer_thinking_effort()}: ${activeThinking.label}`
			: m.chat_composer_thinking_effort(),
	);
	const composerActions = $derived.by<ResponsiveSurfaceAction[]>(() => {
		const actions: ResponsiveSurfaceAction[] = [];
		if (onOpenExpandedEditor) {
			actions.push({
				id: 'expanded-composer',
				label: m.chat_composer_open_expanded_editor(),
				icon: Maximize2,
				onclick: onOpenExpandedEditor,
				disabled: addMenuDisabled || isPromptTransformPending,
				priority: 1,
				buttonClass:
					'size-9 rounded-lg border border-border bg-background text-foreground ring-offset-background hover:bg-muted focus-visible:ring-offset-2',
			});
		}
		if (onRefinePrompt) {
			actions.push({
				id: 'refine-prompt',
				renderKey: isPromptRefinementPending ? 'cancel-refinement' : 'refine-prompt',
				label: promptRefinementActionLabel,
				icon: isPromptRefinementPending ? Square : Sparkles,
				onclick: onRefinePrompt,
				disabled: !isPromptRefinementPending && (!canRefinePrompt || isPromptTransformPending),
				priority: 0,
				buttonClass: `size-9 rounded-lg border ring-offset-background focus-visible:ring-offset-2 ${
					isPromptRefinementPending
						? 'border-accent bg-accent text-accent-foreground hover:bg-accent/80'
						: 'border-border bg-background text-foreground hover:bg-muted'
				}`,
			});
		}
		return actions;
	});
	const composerActionsClass = $derived(
		composerActions.length > 1 ? 'w-9 min-w-9 flex-none sm:w-19' : 'w-9 min-w-9 flex-none',
	);
</script>

<div class="mt-1 w-full min-w-0 max-w-full px-2 py-1.5" data-slot="composer-bottom-bar">
	<div
		class="flex min-w-0 items-center gap-1 sm:gap-2 {mobileRightGroupFullRow
			? 'flex-wrap'
			: 'flex-nowrap'}"
	>
		<div class="flex shrink-0 flex-nowrap items-center gap-1 sm:gap-2">
			{#if showAddMenu}
				<ComposerAddMenu
					disabled={addMenuDisabled || isPromptTransformPending}
					{canAttachImages}
					{attachImagesTooltip}
					{onAddImage}
					{onOpenSnippetPalette}
				/>
			{/if}

			<DropdownMenu>
				<DropdownMenuTrigger
					class="inline-flex size-9 items-center justify-center rounded-lg border transition-colors {activePermission?.toneClass}"
					title={activePermission?.label ?? m.chat_composer_permission_mode()}
					aria-label={permissionControlLabel}
				>
					{#if activePermission}
						<ComposerModeIcon iconId={activePermission.iconId} class="size-4" />
					{/if}
				</DropdownMenuTrigger>
				<DropdownMenuContent align="start">
					{#each permissionOptions as option (option.value)}
						<DropdownMenuItem onclick={() => onPermissionSelect(option.value)} class="items-start">
							<ComposerModeIcon iconId={option.iconId} class="mt-0.5 size-4" />
							<div class="min-w-0">
								<div class="font-medium">{option.label}</div>
								<div class="text-xs text-muted-foreground">{option.description}</div>
							</div>
						</DropdownMenuItem>
					{/each}
				</DropdownMenuContent>
			</DropdownMenu>

			<DropdownMenu>
				<DropdownMenuTrigger
					data-slot="thinking-mode-trigger"
					data-rainbow={activeThinking?.rainbow ? 'true' : undefined}
					class="inline-flex size-9 items-center justify-center rounded-lg border transition-colors {activeThinking?.toneClass}"
					title={activeThinking?.label ?? m.chat_composer_thinking_effort()}
					aria-label={thinkingControlLabel}
				>
					{#if activeThinking}
						<ComposerModeIcon
							iconId={activeThinking.iconId}
							rainbow={activeThinking.rainbow}
							class="size-4"
						/>
					{/if}
				</DropdownMenuTrigger>
				<DropdownMenuContent align="start">
					{#each thinkingOptions as option (option.value)}
						<DropdownMenuItem
							onclick={() => onThinkingSelect(option.value)}
							class={option.rainbow ? 'rainbow-ultra-surface items-start' : 'items-start'}
							data-thinking-mode={option.value}
							data-rainbow={option.rainbow ? 'true' : undefined}
						>
							<ComposerModeIcon
								iconId={option.iconId}
								rainbow={option.rainbow}
								class="mt-0.5 size-4"
							/>
							<div class="min-w-0">
								<div class="font-medium">{option.label}</div>
								<div
									class={option.rainbow ? 'text-xs text-white' : 'text-xs text-muted-foreground'}
								>
									{option.description}
								</div>
							</div>
						</DropdownMenuItem>
					{/each}
				</DropdownMenuContent>
			</DropdownMenu>

			{#if agentSettings}
				{@render agentSettings()}
			{/if}
		</div>

		{#if selectorsSide === 'left' && modelSelector}
			{@render modelSelector()}
		{/if}

		<div
			class="ml-auto flex min-w-0 flex-1 items-center gap-1 sm:gap-2 {mobileRightGroupFullRow
				? 'order-first basis-full justify-between sm:order-none sm:basis-auto sm:justify-end'
				: 'justify-end'}"
		>
			{#if selectorsSide === 'right' && modelSelector}
				{@render modelSelector()}
			{/if}

			{#if composerActions.length > 0}
				<ResponsiveSurfaceActions
					actions={composerActions}
					menuLabel={m.chat_composer_more_actions()}
					menuButtonClass="size-9 rounded-lg border border-border bg-background text-foreground ring-offset-background hover:bg-muted focus-visible:ring-offset-2"
					class={composerActionsClass}
				/>
			{/if}

			{#if showSendButton}
				<button
					type="button"
					onclick={onSend}
					disabled={!canSend || isPromptTransformPending}
					class="inline-flex size-9 shrink-0 items-center justify-center rounded-full border transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 ring-offset-background disabled:bg-muted disabled:text-muted-foreground disabled:border-border disabled:cursor-not-allowed {sendButtonClass}"
					title={sendActionLabel}
					aria-label={sendActionLabel}
				>
					{#if isPromptTransformPending}
						<Loader2 class="size-4 animate-spin" aria-hidden="true" />
					{:else}
						<Send class="size-4" aria-hidden="true" />
					{/if}
				</button>
			{/if}
		</div>
	</div>
</div>
<span class="sr-only" aria-live="polite">
	{isPromptTransformPending ? promptTransformStatus : ''}
</span>
