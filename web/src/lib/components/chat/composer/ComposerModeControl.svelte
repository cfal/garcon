<script lang="ts" generics="T extends string">
	import type { ComposerModeOption } from '$lib/chat/composer/composer-controls.js';
	import { DropdownMenuRadioGroup, DropdownMenuRadioItem } from '$lib/components/ui/dropdown-menu';
	import ComposerSettingMenu from './ComposerSettingMenu.svelte';
	import ComposerModeIcon from './ComposerModeIcon.svelte';

	let {
		id,
		label,
		options,
		selected,
		onSelect,
		overflow,
		align,
		side,
		disabled,
	}: {
		id: 'permission' | 'effort';
		label: string;
		options: ComposerModeOption<T>[];
		selected: T;
		onSelect: (value: T) => void;
		overflow: boolean;
		align: 'start' | 'end';
		side: 'top' | 'bottom';
		disabled: boolean;
	} = $props();
	const active = $derived(options.find((option) => option.value === selected) ?? options[0]);
</script>

<ComposerSettingMenu
	{id}
	{label}
	value={active.label}
	{overflow}
	{align}
	{side}
	{disabled}
	tone={active.toneClass}
	rainbow={active.rainbow}
	triggerSlot={id === 'effort' ? 'thinking-mode-trigger' : undefined}
>
	{#snippet icon()}<ComposerModeIcon
			iconId={active.iconId}
			rainbow={active.rainbow}
			class="size-4"
		/>{/snippet}
	<DropdownMenuRadioGroup value={active.value}>
		{#each options as option (option.value)}
			<DropdownMenuRadioItem
				value={option.value}
				onSelect={() => onSelect(option.value)}
				data-thinking-mode={id === 'effort' ? option.value : undefined}
				data-rainbow={option.rainbow || undefined}
				class={option.rainbow ? 'rainbow-ultra-surface items-start' : 'items-start'}
			>
				<ComposerModeIcon iconId={option.iconId} rainbow={option.rainbow} class="mt-0.5 size-4" />
				<div class="min-w-0">
					<div class="font-medium">{option.label}</div>
					<div
						data-menu-description
						class={option.rainbow ? 'text-xs text-white' : 'text-xs text-muted-foreground'}
					>
						{option.description}
					</div>
				</div>
			</DropdownMenuRadioItem>
		{/each}
	</DropdownMenuRadioGroup>
</ComposerSettingMenu>
