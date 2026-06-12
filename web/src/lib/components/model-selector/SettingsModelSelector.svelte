<script lang="ts">
	import ModelSelectorPopover from './ModelSelectorPopover.svelte';
	import type {
		ModelSelectorChange,
		ModelSelectorMode,
		ModelSelectorValue,
	} from './model-selector-types';

	interface Props {
		value: ModelSelectorValue;
		mode: ModelSelectorMode;
		onChange: (next: ModelSelectorChange) => void | Promise<void>;
		disabled?: boolean;
		align?: 'start' | 'center' | 'end';
		side?: 'top' | 'right' | 'bottom' | 'left';
	}

	let { value, mode, onChange, disabled = false, align = 'end', side = 'bottom' }: Props = $props();
</script>

<ModelSelectorPopover
	{value}
	mode={{ ...mode, surface: 'settings' }}
	{onChange}
	{disabled}
	{align}
	{side}
/>
