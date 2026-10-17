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
		'grid w-16 grid-cols-[1fr_0.75rem] gap-1 px-2 text-xs',
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
	<Lock class={['size-3', mode !== 'locked' && 'invisible']} aria-hidden="true" />
</button>
<span id={modeId} class="sr-only">{modeLabel}</span>
