<script lang="ts">
	import type { Snippet } from 'svelte';
	import * as Tooltip from '$lib/components/ui/tooltip';

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
		children
	}: WorkspaceToolbarButtonProps = $props();
</script>

<Tooltip.Provider delayDuration={150} skipDelayDuration={100}>
	<Tooltip.Root>
		<Tooltip.Trigger
			type="button"
			{onclick}
			class={className}
			aria-label={label}
			aria-pressed={pressed === undefined ? undefined : pressed}
		>
			{@render children?.()}
		</Tooltip.Trigger>
		<Tooltip.Content side="bottom" sideOffset={6}>{label}</Tooltip.Content>
	</Tooltip.Root>
</Tooltip.Provider>
