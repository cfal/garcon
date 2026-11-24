<script lang="ts" generics="T extends string">
	import { DropdownMenuRadioGroup, DropdownMenuRadioItem } from '$lib/components/ui/dropdown-menu';
	import ComposerSettingMenu from './ComposerSettingMenu.svelte';
	import ComposerModeIcon from './ComposerModeIcon.svelte';
	import type { ComposerControlPlacement } from '$lib/chat/composer/composer-toolbar-layout';
	import type { ComposerModeSelection } from './composer-toolbar-types';

	let {
		id,
		label,
		options,
		selected,
		onSelect,
		placement,
		align,
		side,
		disabled,
	}: ComposerModeSelection<T> & {
		id: 'permission' | 'effort';
		label: string;
		placement: ComposerControlPlacement;
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
	{placement}
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
				{disabled}
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
