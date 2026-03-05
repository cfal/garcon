<script lang="ts">
	import {
		DropdownMenu,
		DropdownMenuContent,
		DropdownMenuItem,
		DropdownMenuTrigger,
	} from '$lib/components/ui/dropdown-menu';
	import type { SessionProvider } from '$lib/types/app';
	import type { PermissionMode } from '$lib/types/chat';
	import type { ComposerMenuOption, ComposerModeOption } from '$lib/chat/composer-controls';
	import ComposerModeIcon from './ComposerModeIcon.svelte';
	import { Check, ChevronDown, ImagePlus, Plus, Send } from '@lucide/svelte';

	interface Props {
		canAttachImages: boolean;
		attachImagesTooltip: string;
		onAddImage: () => void;
		permissionOptions: ComposerModeOption<PermissionMode>[];
		selectedPermission: PermissionMode;
		onPermissionSelect: (mode: PermissionMode) => void;
		thinkingOptions: ComposerModeOption[];
		selectedThinking: string;
		onThinkingSelect: (mode: string) => void;
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
	const hasAmpQuickToggle = $derived(
		selectedProvider === 'amp'
		&& modelOptions.some((option) => option.value === 'smart')
		&& modelOptions.some((option) => option.value === 'deep')
	);
	const AMP_QUICK_MODES: Array<{ value: 'smart' | 'deep'; label: string }> = [
		{ value: 'smart', label: 'Smart' },
		{ value: 'deep', label: 'Deep' },
	];
</script>

{#snippet providerAndModelSelectors(align: 'start' | 'end')}
	{#if providerOptions && activeProvider && onProviderSelect}
		<DropdownMenu>
			<DropdownMenuTrigger
				class="inline-flex h-9 items-center gap-1.5 rounded-lg px-2.5 text-sm text-foreground transition-colors hover:bg-muted min-w-0"
				title={activeProvider.label}
			>
				<span class="truncate max-w-[7rem]">{activeProvider.label}</span>
				<ChevronDown class="size-3.5 text-muted-foreground" />
			</DropdownMenuTrigger>
			<DropdownMenuContent align={align}>
				{#each providerOptions as option (option.value)}
					<DropdownMenuItem onclick={() => onProviderSelect(option.value)} class="items-start gap-2">
						<div class="min-w-0 flex-1">
							<div class="font-medium">{option.label}</div>
							<div class="text-xs text-muted-foreground">{option.description}</div>
						</div>
						{#if option.value === selectedProvider}
							<Check class="mt-0.5 size-4 text-primary" />
						{/if}
					</DropdownMenuItem>
				{/each}
			</DropdownMenuContent>
		</DropdownMenu>
	{/if}

	{#if hasAmpQuickToggle}
		<div
			class="inline-flex h-9 items-center gap-0.5 rounded-lg border border-border bg-muted/40 p-0.5"
			title="Amp mode"
		>
			{#each AMP_QUICK_MODES as option (option.value)}
				<button
					type="button"
					onclick={() => onModelSelect(option.value)}
					class="inline-flex h-7 items-center justify-center rounded-md px-2 text-xs font-medium transition-colors {
						selectedModel === option.value
							? 'bg-background text-foreground shadow-sm border border-border'
							: 'text-muted-foreground hover:bg-muted hover:text-foreground'
					}"
				>
					{option.label}
				</button>
			{/each}
		</div>
	{/if}

	<DropdownMenu>
		<DropdownMenuTrigger
			class="inline-flex h-9 items-center gap-1.5 rounded-lg px-2.5 text-sm text-foreground transition-colors hover:bg-muted min-w-0"
			title={activeModel?.label ?? 'Model'}
		>
			<span class="truncate max-w-[10rem]">{activeModel?.label ?? ''}</span>
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
{/snippet}

<div class="mt-1 pt-1.5 px-2 pb-[env(safe-area-inset-bottom)]">
	<div class="flex items-center justify-between gap-2">
		<div class="flex items-center gap-2">
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

		<div class="flex items-center gap-2 min-w-0">
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
