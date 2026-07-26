<script lang="ts">
	import { type Snippet } from 'svelte';
	import X from '@lucide/svelte/icons/x';
	import ResponsiveSurfaceActions, {
		type ResponsiveSurfaceAction,
	} from '$lib/components/shared/ResponsiveSurfaceActions.svelte';
	import type { GitTargetSessionController } from '$lib/git/targets/git-target-session.svelte.js';
	import GitTargetSelector from './GitTargetSelector.svelte';
	import * as m from '$lib/paraglide/messages.js';

	let {
		target,
		presentation,
		leading,
		actions,
		fixed,
		onClose,
		closeDisabled = false,
	}: {
		target: GitTargetSessionController;
		presentation: 'main' | 'sidebar' | 'mobile';
		leading?: Snippet;
		actions: readonly ResponsiveSurfaceAction[];
		fixed?: Snippet;
		onClose?: () => void;
		closeDisabled?: boolean;
	} = $props();
</script>

{#snippet fixedControls()}
	{@render fixed?.()}
{/snippet}

<div
	class="flex min-h-10 min-w-0 items-center gap-2 border-b border-border bg-background px-2"
	data-git-surface-toolbar
>
	{@render leading?.()}
	<GitTargetSelector
		{target}
		isMobile={presentation === 'mobile'}
		disabled={!target.canChangeTarget}
	/>
	<ResponsiveSurfaceActions
		{actions}
		menuLabel={m.git_more_actions()}
		fixed={fixedControls}
	/>
	{#if presentation === 'mobile' && onClose}
		<button
			type="button"
			class="flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
			onclick={onClose}
			disabled={closeDisabled}
			aria-label={m.workspace_close_view()}
			title={m.workspace_close_view()}
		>
			<X class="size-4" />
		</button>
	{/if}
</div>
