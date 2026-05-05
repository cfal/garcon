<script lang="ts">
	import {
		DropdownMenu,
		DropdownMenuContent,
		DropdownMenuItem,
		DropdownMenuTrigger,
	} from '$lib/components/ui/dropdown-menu';
	import type { Snippet } from 'svelte';
	import type { PermissionMode, ThinkingMode } from '$lib/types/chat';
	import type { ComposerModeOption } from '$lib/chat/composer-controls';
	import ComposerModeIcon from './ComposerModeIcon.svelte';
	import { ImagePlus, Plus, Send } from '@lucide/svelte';
	import * as m from '$lib/paraglide/messages.js';

	interface Props {
		canAttachImages: boolean;
		attachImagesTooltip: string;
		onAddImage: () => void;
		permissionOptions: ComposerModeOption<PermissionMode>[];
		selectedPermission: PermissionMode;
		onPermissionSelect: (mode: PermissionMode) => void;
			thinkingOptions: ComposerModeOption<ThinkingMode>[];
			selectedThinking: ThinkingMode;
			onThinkingSelect: (mode: ThinkingMode) => void;
			modelSelector?: Snippet;
			canSend: boolean;
			onSend: () => void;
			sendTitle: string;
		sendButtonClass: string;
		selectorsSide?: 'left' | 'right';
		mobileRightGroupFullRow?: boolean;
	}

	let {
		canAttachImages,
		attachImagesTooltip,
		onAddImage,
		permissionOptions,
		selectedPermission,
		onPermissionSelect,
			thinkingOptions,
			selectedThinking,
			onThinkingSelect,
			modelSelector,
			canSend,
			onSend,
			sendTitle,
		sendButtonClass,
		selectorsSide = 'right',
		mobileRightGroupFullRow = false,
	}: Props = $props();

	const activePermission = $derived(
		permissionOptions.find((option) => option.value === selectedPermission) ?? permissionOptions[0]
	);
		const activeThinking = $derived(
			thinkingOptions.find((option) => option.value === selectedThinking) ?? thinkingOptions[0]
		);
	</script>

<div class="mt-1 pt-1.5 px-2 pb-[env(safe-area-inset-bottom)]">
	<div class="flex min-w-0 flex-wrap items-center gap-2">
		<div class="flex min-w-0 grow flex-wrap items-center gap-2">
			<DropdownMenu>
				<DropdownMenuTrigger
					disabled={!canAttachImages}
					class="inline-flex size-9 items-center justify-center rounded-lg border border-border bg-background text-muted-foreground transition-colors hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
					title={canAttachImages ? m.chat_composer_add_attachment() : attachImagesTooltip}
				>
					<Plus class="size-4" />
				</DropdownMenuTrigger>
				<DropdownMenuContent align="start">
					<DropdownMenuItem onclick={onAddImage} disabled={!canAttachImages} class="items-start">
						<ImagePlus class="mt-0.5 size-4" />
						<div class="min-w-0">
							<div class="font-medium">{m.chat_composer_add_image()}</div>
							<div class="text-xs text-muted-foreground">{m.chat_composer_attach_image_files()}</div>
						</div>
					</DropdownMenuItem>
				</DropdownMenuContent>
			</DropdownMenu>

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
					class="inline-flex size-9 items-center justify-center rounded-lg border transition-colors {activeThinking?.toneClass}"
					title={activeThinking?.label ?? m.chat_composer_thinking_effort()}
				>
					{#if activeThinking}
						<ComposerModeIcon iconId={activeThinking.iconId} class="size-4" />
					{/if}
				</DropdownMenuTrigger>
				<DropdownMenuContent align="start">
					{#each thinkingOptions as option (option.value)}
						<DropdownMenuItem onclick={() => onThinkingSelect(option.value)} class="items-start">
							<ComposerModeIcon iconId={option.iconId} class="mt-0.5 size-4" />
							<div class="min-w-0">
								<div class="font-medium">{option.label}</div>
								<div class="text-xs text-muted-foreground">{option.description}</div>
							</div>
						</DropdownMenuItem>
					{/each}
				</DropdownMenuContent>
			</DropdownMenu>

				{#if selectorsSide === 'left' && modelSelector}
					{@render modelSelector()}
				{/if}
			</div>

		<div
			class="flex min-w-0 items-center justify-between gap-2 sm:ml-auto sm:basis-auto sm:justify-end"
			class:basis-full={mobileRightGroupFullRow}
		>
				{#if selectorsSide === 'right' && modelSelector}
					{@render modelSelector()}
				{/if}

			<button
				type="button"
				onclick={onSend}
				disabled={!canSend}
				class="inline-flex size-9 items-center justify-center rounded-full border transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 ring-offset-background disabled:bg-muted disabled:text-muted-foreground disabled:border-border disabled:cursor-not-allowed {sendButtonClass}"
				title={sendTitle}
			>
				<Send class="size-4" />
			</button>
		</div>
	</div>
</div>
