<script lang="ts">
	import {
		DropdownMenu,
		DropdownMenuContent,
		DropdownMenuItem,
		DropdownMenuTrigger,
	} from '$lib/components/ui/dropdown-menu';
	import type { Snippet as SvelteSnippet } from 'svelte';
	import type { SnippetInsertionHandler } from '$lib/chat/composer/snippet-insertion.js';
	import type { PermissionMode, ThinkingMode } from '$lib/types/chat';
	import type { ComposerModeOption } from '$lib/chat/composer/composer-controls.js';
	import ComposerModeIcon from './ComposerModeIcon.svelte';
	import Loader2 from '@lucide/svelte/icons/loader-2';
	import Send from '@lucide/svelte/icons/send';
	import * as m from '$lib/paraglide/messages.js';
	import ComposerAddMenu from './ComposerAddMenu.svelte';

	interface Props {
		canAttachImages: boolean;
		snippetInteractionKey?: string;
		attachImagesTooltip: string;
		onAddImage: () => void;
		onInsertSnippet?: SnippetInsertionHandler;
		onEditSnippets?: () => void;
		onRequestComposerFocus?: () => void;
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
	}

	let {
		canAttachImages,
		snippetInteractionKey = '',
		attachImagesTooltip,
		onAddImage,
		onInsertSnippet = () => 'cancelled',
		onEditSnippets = () => undefined,
		onRequestComposerFocus = () => undefined,
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
	}: Props = $props();

	const activePermission = $derived(
		permissionOptions.find((option) => option.value === selectedPermission) ?? permissionOptions[0],
	);
	const activeThinking = $derived(
		thinkingOptions.find((option) => option.value === selectedThinking) ?? thinkingOptions[0],
	);
</script>

<div class="mt-1 px-2 py-1.5" data-slot="composer-bottom-bar">
	<div class="flex min-w-0 flex-wrap items-center gap-2">
		<div class="flex min-w-0 grow flex-wrap items-center gap-2">
			{#if showAddMenu}
				<ComposerAddMenu
					disabled={addMenuDisabled || isPromptTransformPending}
					interactionKey={snippetInteractionKey}
					{canAttachImages}
					{attachImagesTooltip}
					{onAddImage}
					{onInsertSnippet}
					{onEditSnippets}
					{onRequestComposerFocus}
				/>
			{/if}

			<DropdownMenu>
				<DropdownMenuTrigger
					class="inline-flex size-9 items-center justify-center rounded-lg border transition-colors {activePermission?.toneClass}"
					title={activePermission?.label ?? m.chat_composer_permission_mode()}
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

			{#if selectorsSide === 'left' && modelSelector}
				{@render modelSelector()}
			{/if}
		</div>

		<div
			class="flex min-w-0 items-center justify-between gap-2 sm:ml-auto sm:basis-auto sm:justify-end {mobileRightGroupFullRow
				? 'order-first sm:order-none'
				: ''}"
			class:basis-full={mobileRightGroupFullRow}
		>
			{#if mobileRightGroupFullRow}
				<div class="min-w-0 flex-1 sm:flex-none">
					{#if selectorsSide === 'right' && modelSelector}
						{@render modelSelector()}
					{/if}
				</div>
			{:else if selectorsSide === 'right' && modelSelector}
				{@render modelSelector()}
			{/if}

			{#if showSendButton}
				<button
					type="button"
					onclick={onSend}
					disabled={!canSend || isPromptTransformPending}
					class="inline-flex size-9 items-center justify-center rounded-full border transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 ring-offset-background disabled:bg-muted disabled:text-muted-foreground disabled:border-border disabled:cursor-not-allowed {sendButtonClass}"
					title={isPromptTransformPending ? m.snippets_expanding() : sendTitle}
					aria-label={isPromptTransformPending ? m.snippets_expanding() : sendTitle}
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
	{isPromptTransformPending ? m.snippets_expanding() : ''}
</span>
