<script lang="ts">
	import CircleCheck from '@lucide/svelte/icons/circle-check';
	import CircleX from '@lucide/svelte/icons/circle-x';
	import CircleDot from '@lucide/svelte/icons/circle-dot';
	import type { PullRequestChecksState } from '$lib/api/pull-requests';
	import { cn } from '$lib/utils/cn.js';
	import { checksStateClass, checksStateLabel } from './pr-display.js';

	let {
		checksState,
		class: className = '',
	}: { checksState: PullRequestChecksState; class?: string } = $props();

	const iconClass = $derived(cn('shrink-0', checksStateClass(checksState), className));
	const label = $derived(checksStateLabel(checksState));
</script>

<!-- Pull requests without checks show nothing rather than a neutral placeholder. -->
{#if checksState !== 'none'}
	<span
		class="inline-flex"
		role="img"
		aria-label={label}
		title={label}
		data-pr-checks-state={checksState}
	>
		{#if checksState === 'passing'}
			<CircleCheck class={iconClass} aria-hidden="true" />
		{:else if checksState === 'failing'}
			<CircleX class={iconClass} aria-hidden="true" />
		{:else}
			<CircleDot class={iconClass} aria-hidden="true" />
		{/if}
	</span>
{/if}
