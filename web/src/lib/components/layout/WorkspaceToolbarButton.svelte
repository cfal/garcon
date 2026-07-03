<script lang="ts">
	import type { Snippet } from 'svelte';

	interface WorkspaceToolbarButtonProps {
		label: string;
		class?: string;
		pressed?: boolean;
		onclick?: () => void;
		children?: Snippet;
	}

	let {
		label,
		class: className,
		pressed,
		onclick,
		children,
	}: WorkspaceToolbarButtonProps = $props();
</script>

<button
	type="button"
	{onclick}
	class={className}
	aria-label={label}
	aria-pressed={pressed === undefined ? undefined : pressed}
>
	{@render children?.()}
</button>
