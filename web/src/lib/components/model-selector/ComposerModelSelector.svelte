<script lang="ts">
	import ModelSelectorPopover from './ModelSelectorPopover.svelte';
	import type { SessionAgentId } from '$lib/types/app';
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
		selectableAgentIds?: readonly SessionAgentId[];
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
		selectableAgentIds,
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
	{selectableAgentIds}
	{disabled}
	{align}
	{side}
/>
