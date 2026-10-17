<script lang="ts">
	import Lock from '@lucide/svelte/icons/lock';
	import { buttonVariants } from '$lib/components/ui/button';
	import type { TerminalModifierMode } from '$lib/terminal/runtime/terminal-input-controls.svelte.js';
	import { cn } from '$lib/utils/cn.js';
	import * as m from '$lib/paraglide/messages.js';

	let {
		label,
		mode,
		onToggle,
	}: {
		label: string;
		mode: TerminalModifierMode;
		onToggle: () => void;
	} = $props();
	const modeId = $props.id();
	const modeLabel = $derived.by(() => {
		switch (mode) {
			case 'inactive':
				return m.terminal_modifier_inactive();
			case 'pending':
				return m.terminal_modifier_pending();
			case 'locked':
				return m.terminal_modifier_locked();
		}
	});
</script>

<button
	type="button"
	class={cn(
		buttonVariants({ variant: 'outline', size: 'sm' }),
		'relative px-2 text-xs has-[>svg]:px-2',
		mode !== 'inactive' &&
			'border-interactive-accent bg-interactive-accent text-interactive-accent-foreground hover:bg-interactive-accent',
	)}
	aria-label={label}
	aria-describedby={modeId}
	aria-pressed={mode !== 'inactive'}
	title={`${label}: ${modeLabel}`}
	onpointerdown={(event) => event.preventDefault()}
	onclick={onToggle}
>
	{label}
	<Lock
		class={['absolute right-0.5 top-0.5 size-2', mode !== 'locked' && 'invisible']}
		aria-hidden="true"
	/>
</button>
<span id={modeId} class="sr-only">{modeLabel}</span>
