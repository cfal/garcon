<script lang="ts">
	import ModelSelectorPopover from './ModelSelectorPopover.svelte';
	import type {
		ModelSelectorChange,
		ModelSelectorMode,
		ModelSelectorRecentOption,
		ModelSelectorValue,
	} from './model-selector-types';

	interface Props {
		value: ModelSelectorValue;
		mode: ModelSelectorMode;
		onChange: (next: ModelSelectorChange) => void | Promise<void>;
		recents?: ModelSelectorRecentOption[];
		preferRecentsOnOpen?: boolean;
		disabled?: boolean;
		align?: 'start' | 'center' | 'end';
		side?: 'top' | 'right' | 'bottom' | 'left';
	}

	let {
		value,
		mode,
		onChange,
		recents = [],
		preferRecentsOnOpen = false,
		disabled = false,
		align = 'end',
		side = 'bottom',
	}: Props = $props();
</script>

<ModelSelectorPopover
	{value}
	mode={{ ...mode, surface: 'composer' }}
	{onChange}
	{recents}
	{preferRecentsOnOpen}
	{disabled}
	{align}
	{side}
/>
