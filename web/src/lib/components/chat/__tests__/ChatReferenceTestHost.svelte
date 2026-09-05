<script lang="ts">
	import type { ChatReferenceResolution } from '$lib/chat/transcript/chat-reference.js';
	import ChatReference from '../ChatReference.svelte';

	interface Props {
		chatId: string;
		resolution: ChatReferenceResolution | null;
		authoredLabelText?: string | null;
		authoredTitle?: string | null;
		customLabel?: boolean;
		linkClass?: string;
		inertTooltipPolicy?: 'informative' | 'always';
		onParentPointerDown?: () => void;
		onParentContextMenu?: () => void;
	}

	let {
		chatId,
		resolution,
		authoredLabelText = null,
		authoredTitle = null,
		customLabel = false,
		linkClass = '',
		inertTooltipPolicy = 'informative',
		onParentPointerDown = () => {},
		onParentContextMenu = () => {},
	}: Props = $props();
</script>

<div
	role="group"
	aria-label="Reference host"
	onpointerdown={onParentPointerDown}
	oncontextmenu={onParentContextMenu}
>
	<ChatReference
		{chatId}
		{resolution}
		{authoredLabelText}
		{authoredTitle}
		{linkClass}
		{inertTooltipPolicy}
	>
		{#snippet authoredLabel()}
			{#if customLabel}
				<strong>Custom label</strong>
			{/if}
		{/snippet}
	</ChatReference>
</div>
