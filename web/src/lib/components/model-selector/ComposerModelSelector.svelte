<script lang="ts">
	import ModelSelectorPopover from './ModelSelectorPopover.svelte';
	import type { ModelTriggerDisplay, ModelTriggerWidths } from '$lib/agents/model-trigger-fit';
	import type { SessionAgentId } from '$lib/chat/sessions/chat-session-types';
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
		getRecents?: (executorId: string) => ModelSelectorRecentOption[];
		preferRecentsOnOpen?: boolean;
		getSelectableAgentIds?: (executorId: string) => readonly SessionAgentId[];
		disabled?: boolean;
		overflowAnchor?: HTMLElement | null;
		toolbarDisplay?: ModelTriggerDisplay;
		onMeasure?: (widths: ModelTriggerWidths) => void;
		align?: 'start' | 'center' | 'end';
		side?: 'top' | 'right' | 'bottom' | 'left';
	}

	let {
		value,
		mode,
		onChange,
		getRecents,
		preferRecentsOnOpen = false,
		getSelectableAgentIds,
		disabled = false,
		overflowAnchor,
		toolbarDisplay,
		onMeasure,
		align = 'end',
		side = 'bottom',
	}: Props = $props();
	let picker = $state<ModelSelectorPopover>();
	export function selectionSummary(): string { return picker?.selectionSummary() ?? ''; }
	export function openPicker(): void { picker?.openPicker(); }
	export function dismissPicker(): void { picker?.dismissPicker(); }
</script>

<ModelSelectorPopover
	bind:this={picker}
	{overflowAnchor}
	{toolbarDisplay}
	{onMeasure}
	{value}
	mode={{ ...mode, executor: 'fixed', surface: 'composer' }}
	{onChange}
	{getRecents}
	{preferRecentsOnOpen}
	{getSelectableAgentIds}
	{disabled}
	{align}
	{side}
/>
