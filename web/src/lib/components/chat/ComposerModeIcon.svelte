<script lang="ts">
	import type { ComposerModeIconId } from '$lib/chat/composer-controls';

	interface Props {
		iconId: ComposerModeIconId;
		class?: string;
	}

	let { iconId, class: className = 'size-4' }: Props = $props();
</script>

<svg
	viewBox="0 0 24 24"
	fill="none"
	stroke="currentColor"
	stroke-width="1.8"
	stroke-linecap="round"
	stroke-linejoin="round"
	class={className}
	aria-hidden="true"
>
	{#if iconId === 'permission-default'}
		<path d="M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6l7-3z" />
	{:else if iconId === 'permission-accept-edits'}
		<path d="M4 17.5V20h2.5L17.8 8.7l-2.5-2.5L4 17.5z" />
		<path d="M14.7 4.5l2.5 2.5" />
	{:else if iconId === 'permission-bypass'}
		<path d="M13 2L4 14h7l-1 8 10-13h-7l0-7z" />
	{:else if iconId === 'permission-plan'}
		<path d="M4 4h5l3 3h8v13H4z" />
		<path d="M9 4v5h5" />
	{:else if iconId === 'thinking-none'}
		<circle cx="12" cy="12" r="8" />
		<circle cx="12" cy="12" r="1.2" fill="currentColor" stroke="none" />
	{:else if iconId === 'thinking-think'}
		<path d="M9.5 18h5" />
		<path d="M10.2 21h3.6" />
		<path d="M8.7 14.6a5.8 5.8 0 117.1 0c-.8.8-1.4 1.5-1.4 2.4h-4.2c0-.9-.7-1.6-1.5-2.4z" />
	{:else if iconId === 'thinking-think-hard'}
		<path d="M8 6.5a4 4 0 017 2" />
		<path d="M7 12a5 5 0 009 2.8" />
		<path d="M7.5 16.5L6 20l3.4-1.4" />
	{:else if iconId === 'thinking-think-harder'}
		<path d="M8 12a4 4 0 014-4h1" />
		<path d="M10.5 18H13a4 4 0 004-4" />
		<path d="M16.5 6.5l.8 1.6 1.8.2-1.3 1.3.3 1.8-1.6-.8-1.6.8.3-1.8-1.3-1.3 1.8-.2z" />
	{:else}
		<path d="M12 3l2.4 4.8L20 10l-4 4 .9 6-4.9-2.5L7 20l1-6-4-4 5.6-2.2z" />
	{/if}
</svg>
