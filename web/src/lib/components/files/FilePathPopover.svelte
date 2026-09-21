<script lang="ts">
	import * as Popover from '$lib/components/ui/popover';
	import CopyFilePathButton from './CopyFilePathButton.svelte';
	import * as m from '$lib/paraglide/messages.js';

	let {
		path,
		label,
		class: className = '',
		current,
	}: { path: string; label: string; class?: string; current?: 'location' } = $props();
</script>

<Popover.Root>
	<Popover.Trigger
		class="min-w-0 truncate rounded-sm text-left hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none {className}"
		title={path}
		aria-label={path}
		aria-current={current}
	>
		{label}
	</Popover.Trigger>
	<Popover.Content
		align="start"
		class="flex w-[32rem] max-w-[calc(100vw-1rem)] items-center gap-1.5 p-2"
	>
		<input
			readonly
			value={path}
			aria-label={m.filetree_location()}
			class="min-w-0 flex-1 rounded-sm bg-transparent px-1 py-1 text-base text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none md:text-xs"
			onfocus={(event) => event.currentTarget.select()}
		/>
		<CopyFilePathButton {path} />
	</Popover.Content>
</Popover.Root>
