<script lang="ts">
	import ModelSelectorPopover from './ModelSelectorPopover.svelte';
	import type { SessionAgentId } from '$lib/types/app';
	import type {
		ModelSelectorChange,
		ModelSelectorMode,
		ModelSelectorValue,
	} from './model-selector-types';

	interface Props {
		value: ModelSelectorValue;
		mode: ModelSelectorMode;
		onChange: (next: ModelSelectorChange) => void | Promise<void>;
		selectableAgentIds?: readonly SessionAgentId[];
		disabled?: boolean;
		align?: 'start' | 'center' | 'end';
		side?: 'top' | 'right' | 'bottom' | 'left';
	}

	let {
		value,
		mode,
		onChange,
		selectableAgentIds,
		disabled = false,
		align = 'end',
		side = 'bottom',
	}: Props = $props();
</script>

<ModelSelectorPopover
	{value}
	mode={{ ...mode, surface: 'settings' }}
	{onChange}
	{selectableAgentIds}
	{disabled}
	{align}
	{side}
/>
