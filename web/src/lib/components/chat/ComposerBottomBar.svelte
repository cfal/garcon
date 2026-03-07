<script lang="ts">
	import {
		DropdownMenu,
		DropdownMenuContent,
		DropdownMenuItem,
		DropdownMenuTrigger,
	} from '$lib/components/ui/dropdown-menu';
	import type { SessionProvider } from '$lib/types/app';
	import type { PermissionMode, ThinkingMode } from '$lib/types/chat';
	import type { ComposerMenuOption, ComposerModeOption } from '$lib/chat/composer-controls';
	import ComposerModeIcon from './ComposerModeIcon.svelte';
	import { ChevronDown, ImagePlus, Plus, Send } from '@lucide/svelte';

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
		providerOptions?: ComposerMenuOption<SessionProvider>[];
		selectedProvider?: SessionProvider;
		onProviderSelect?: (provider: SessionProvider) => void;
		modelOptions: ComposerMenuOption[];
		selectedModel: string;
		onModelSelect: (model: string) => void;
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
		providerOptions,
		selectedProvider,
		onProviderSelect,
		modelOptions,
		selectedModel,
		onModelSelect,
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
	const activeProvider = $derived(
		providerOptions?.find((option) => option.value === selectedProvider) ?? providerOptions?.[0]
	);
	const activeModel = $derived(
		modelOptions.find((option) => option.value === selectedModel) ?? modelOptions[0]
	);
</script>

{#snippet providerAndModelSelectors(align: 'start' | 'end')}
	<div class="flex min-w-0 items-center gap-2">
		{#if providerOptions && activeProvider && onProviderSelect}
			<DropdownMenu>
				<DropdownMenuTrigger
					class="inline-flex h-9 max-w-[7rem] items-center gap-1.5 rounded-lg px-2.5 text-sm text-foreground transition-colors hover:bg-muted min-w-0 sm:max-w-[10rem]"
					title={activeProvider.label}
				>
					<span class="truncate max-w-[4.5rem] sm:max-w-[7rem]">{activeProvider.label}</span>
					<ChevronDown class="size-3.5 text-muted-foreground" />
				</DropdownMenuTrigger>
				<DropdownMenuContent align={align}>
					{#each providerOptions as option (option.value)}
						<DropdownMenuItem onclick={() => onProviderSelect(option.value)} class="items-start">
							<div class="min-w-0">
								<div class="font-medium">{option.label}</div>
							</div>
						</DropdownMenuItem>
					{/each}
				</DropdownMenuContent>
			</DropdownMenu>
		{/if}

		<DropdownMenu>
			<DropdownMenuTrigger
				class="inline-flex h-9 max-w-[9rem] items-center gap-1.5 rounded-lg px-2.5 text-sm text-foreground transition-colors hover:bg-muted min-w-0 sm:max-w-[14rem]"
				title={activeModel?.label ?? 'Model'}
			>
				<span class="truncate max-w-[6.5rem] sm:max-w-[10rem]">{activeModel?.label ?? ''}</span>
				<ChevronDown class="size-3.5 text-muted-foreground" />
			</DropdownMenuTrigger>
			<DropdownMenuContent align={align}>
				{#each modelOptions as option (option.value)}
					<DropdownMenuItem onclick={() => onModelSelect(option.value)} class="items-start">
						<div class="min-w-0">
							<div class="font-medium">{option.label}</div>
							<div class="text-xs text-muted-foreground">{option.description}</div>
						</div>
					</DropdownMenuItem>
				{/each}
			</DropdownMenuContent>
		</DropdownMenu>
	</div>
{/snippet}

<div class="mt-1 pt-1.5 px-2 pb-[env(safe-area-inset-bottom)]">
	<div class="flex min-w-0 flex-wrap items-center gap-2">
		<div class="flex min-w-0 grow flex-wrap items-center gap-2">
			<DropdownMenu>
				<DropdownMenuTrigger
					disabled={!canAttachImages}
					class="inline-flex size-9 items-center justify-center rounded-lg border border-border bg-background text-muted-foreground transition-colors hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
					title={canAttachImages ? 'Add attachment' : attachImagesTooltip}
				>
					<Plus class="size-4" />
				</DropdownMenuTrigger>
				<DropdownMenuContent align="start">
					<DropdownMenuItem onclick={onAddImage} disabled={!canAttachImages} class="items-start">
						<ImagePlus class="mt-0.5 size-4" />
						<div class="min-w-0">
							<div class="font-medium">Add image</div>
							<div class="text-xs text-muted-foreground">Attach one or more image files.</div>
						</div>
					</DropdownMenuItem>
				</DropdownMenuContent>
			</DropdownMenu>

			<DropdownMenu>
				<DropdownMenuTrigger
					class="inline-flex size-9 items-center justify-center rounded-lg border transition-colors {activePermission?.toneClass}"
					title={activePermission?.label ?? 'Permission mode'}
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
					title={activeThinking?.label ?? 'Thinking effort'}
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

			{#if selectorsSide === 'left'}
				{@render providerAndModelSelectors('start')}
			{/if}
		</div>

		<div
			class="flex min-w-0 items-center justify-between gap-2 sm:ml-auto sm:basis-auto sm:justify-end"
			class:basis-full={mobileRightGroupFullRow}
		>
			{#if selectorsSide === 'right'}
				{@render providerAndModelSelectors('end')}
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
