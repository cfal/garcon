<script lang="ts">
	import type { HostId, HostState } from '$lib/workspace/surface-types.js';
	import * as m from '$lib/paraglide/messages.js';

	let {
		host,
		hostState,
		labelFor,
		onSelect,
		onFocus,
	}: {
		host: HostId;
		hostState: HostState;
		labelFor: (surfaceId: string) => string;
		onSelect: (surfaceId: string) => void;
		onFocus?: (surfaceId: string) => void;
	} = $props();

	function handleKeydown(event: KeyboardEvent, index: number): void {
		const tabs = Array.from(
			event.currentTarget instanceof HTMLElement
				? (event.currentTarget
						.closest('[role="tablist"]')
						?.querySelectorAll<HTMLElement>('[role="tab"]') ?? [])
				: [],
		);
		if (tabs.length === 0) return;
		let nextIndex: number;
		switch (event.key) {
			case 'ArrowLeft':
				nextIndex = (index - 1 + tabs.length) % tabs.length;
				break;
			case 'ArrowRight':
				nextIndex = (index + 1) % tabs.length;
				break;
			case 'Home':
				nextIndex = 0;
				break;
			case 'End':
				nextIndex = tabs.length - 1;
				break;
			case 'Enter':
			case ' ':
				event.preventDefault();
				onSelect(hostState.order[index]);
				return;
			default:
				return;
		}
		event.preventDefault();
		tabs[nextIndex]?.focus();
	}
</script>

{#snippet tab(surfaceId: string, index: number)}
	<button
		type="button"
		role="tab"
		id={`${host}-tab-${surfaceId}`}
		aria-controls={`${host}-panel-${surfaceId}`}
		aria-selected={hostState.activeId === surfaceId}
		tabindex={hostState.activeId === surfaceId ? 0 : -1}
		class="h-8 max-w-40 shrink-0 truncate rounded-md px-2.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
		class:bg-accent={hostState.activeId === surfaceId}
		class:text-foreground={hostState.activeId === surfaceId}
		title={labelFor(surfaceId)}
		onclick={() => onSelect(surfaceId)}
		onfocus={() => onFocus?.(surfaceId)}
		onpointerdown={() => onFocus?.(surfaceId)}
		onkeydown={(event) => handleKeydown(event, index)}
	>
		{labelFor(surfaceId)}
	</button>
{/snippet}

<div
	class="flex min-w-0 items-center gap-1"
	role="tablist"
	aria-label={host === 'main' ? m.workspace_main_views() : m.workspace_sidebar_views()}
>
	{#if host === 'main' && hostState.order[0] === 'singleton:chat'}
		{@render tab(hostState.order[0], 0)}
	{/if}
	<div class="flex min-w-0 items-center gap-1 overflow-x-auto overscroll-x-contain">
		{#each hostState.order as surfaceId, index (surfaceId)}
			{#if host !== 'main' || index > 0}
				{@render tab(surfaceId, index)}
			{/if}
		{/each}
	</div>
</div>
