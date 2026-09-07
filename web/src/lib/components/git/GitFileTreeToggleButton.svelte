<script lang="ts">
	import PanelLeftClose from '@lucide/svelte/icons/panel-left-close';
	import PanelLeftOpen from '@lucide/svelte/icons/panel-left-open';
	import * as m from '$lib/paraglide/messages.js';

	let {
		visible,
		onToggle,
	}: {
		visible: boolean;
		onToggle: () => void;
	} = $props();

	let label = $derived(visible ? m.git_hide_file_tree() : m.git_show_file_tree());
</script>

<button
	type="button"
	class="rounded p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-interactive-accent"
	aria-label={label}
	aria-pressed={visible}
	title={label}
	data-git-file-tree-toggle
	onclick={onToggle}
>
	{#if visible}
		<PanelLeftClose class="size-4" />
	{:else}
		<PanelLeftOpen class="size-4" />
	{/if}
</button>
