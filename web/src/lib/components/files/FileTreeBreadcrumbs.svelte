<script lang="ts">
	import { untrack } from 'svelte';
	import ChevronRight from '@lucide/svelte/icons/chevron-right';
	import Ellipsis from '@lucide/svelte/icons/ellipsis';
	import Folder from '@lucide/svelte/icons/folder';
	import {
		DropdownMenu,
		DropdownMenuContent,
		DropdownMenuItem,
		DropdownMenuTrigger,
	} from '$lib/components/ui/dropdown-menu';
	import type { FileTreeBreadcrumb } from '$shared/file-contracts';
	import * as m from '$lib/paraglide/messages.js';
	import { selectFileTreeBreadcrumbLayout } from './file-tree-breadcrumb-layout.js';

	let {
		breadcrumbs,
		onNavigate,
	}: {
		breadcrumbs: readonly FileTreeBreadcrumb[];
		onNavigate: (index: number) => void;
	} = $props();

	let root = $state<HTMLElement | null>(null);
	let measurementRail = $state<HTMLElement | null>(null);
	let availableWidth = $state(0);
	let separatorWidth = $state(0);
	let overflowWidth = $state(0);
	let segmentWidths = $state.raw<ReadonlyMap<number, number>>(new Map());

	const layout = $derived(
		selectFileTreeBreadcrumbLayout({
			count: breadcrumbs.length,
			availableWidth,
			segmentWidths,
			separatorWidth,
			overflowWidth,
			gap: 0,
		}),
	);
	const visibleSet = $derived(new Set(layout.visibleIndices));

	function outerWidth(element: HTMLElement | null): number {
		if (!element) return 0;
		const styles = getComputedStyle(element);
		const marginLeft = Number.parseFloat(styles.marginLeft) || 0;
		const marginRight = Number.parseFloat(styles.marginRight) || 0;
		return element.getBoundingClientRect().width + marginLeft + marginRight;
	}

	function measure(): void {
		if (!root || !measurementRail) return;
		const widths = new Map<number, number>();
		for (const element of measurementRail.querySelectorAll<HTMLElement>(
			'[data-breadcrumb-measure]',
		)) {
			const index = Number(element.dataset.breadcrumbMeasure);
			if (Number.isInteger(index)) widths.set(index, element.getBoundingClientRect().width);
		}
		availableWidth = root.clientWidth;
		segmentWidths = widths;
		separatorWidth = outerWidth(
			measurementRail.querySelector<HTMLElement>('[data-breadcrumb-separator-measure]'),
		);
		overflowWidth =
			measurementRail
				.querySelector<HTMLElement>('[data-breadcrumb-overflow-measure]')
				?.getBoundingClientRect().width ?? 0;
	}

	$effect(() => {
		const observedRoot = root;
		const rail = measurementRail;
		if (!observedRoot || !rail || typeof ResizeObserver === 'undefined') return;
		const observer = new ResizeObserver(measure);
		observer.observe(observedRoot);
		observer.observe(rail);
		queueMicrotask(measure);
		return () => observer.disconnect();
	});

	$effect(() => {
		breadcrumbs.map(({ name, path }) => `${name}:${path}`).join('|');
		untrack(() => queueMicrotask(measure));
	});
</script>

<nav
	aria-label={m.filetree_location()}
	class="relative flex h-8 min-w-0 shrink-0 items-center overflow-hidden border-b border-border bg-card px-2 text-xs"
	data-file-tree-breadcrumbs
>
	<Folder class="mr-1.5 h-3.5 w-3.5 shrink-0 text-file-icon-folder" aria-hidden="true" />
	<div bind:this={root} class="relative flex min-w-0 flex-1 items-center overflow-hidden">
		{#each breadcrumbs as breadcrumb, index (breadcrumb.path)}
			{#if visibleSet.has(index)}
				{#if index > 0}
					<ChevronRight class="mx-0.5 h-3 w-3 shrink-0 text-muted-foreground" aria-hidden="true" />
				{/if}
				{#if index === breadcrumbs.length - 1}
					<span
						class="min-w-0 flex-1 truncate px-1 font-medium text-foreground"
						aria-current="location"
						aria-label={breadcrumb.path}
						title={breadcrumb.path}
					>
						{breadcrumb.name}
					</span>
				{:else}
					<button
						type="button"
						class="min-w-0 max-w-[40%] shrink truncate rounded-sm px-1 py-0.5 text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
						aria-label={breadcrumb.path}
						title={breadcrumb.path}
						onclick={() => onNavigate(index)}
					>
						{breadcrumb.name}
					</button>
				{/if}
			{:else if layout.overflowIndices[0] === index}
				<ChevronRight class="mx-0.5 h-3 w-3 shrink-0 text-muted-foreground" aria-hidden="true" />
				<DropdownMenu>
					<DropdownMenuTrigger
						class="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
						aria-label={m.filetree_location()}
					>
						<Ellipsis class="h-3.5 w-3.5" />
					</DropdownMenuTrigger>
					<DropdownMenuContent align="start">
						{#each layout.overflowIndices as overflowIndex}
							<DropdownMenuItem
								aria-label={breadcrumbs[overflowIndex]?.path}
								title={breadcrumbs[overflowIndex]?.path}
								onclick={() => onNavigate(overflowIndex)}
							>
								{breadcrumbs[overflowIndex]?.name}
							</DropdownMenuItem>
						{/each}
					</DropdownMenuContent>
				</DropdownMenu>
			{/if}
		{/each}

		<div
			bind:this={measurementRail}
			class="pointer-events-none invisible absolute -left-[10000px] top-0 flex items-center"
			aria-hidden="true"
		>
			{#each breadcrumbs as breadcrumb, index (breadcrumb.path)}
				<span data-breadcrumb-measure={index} class="whitespace-nowrap px-1 text-xs">
					{breadcrumb.name}
				</span>
			{/each}
			<ChevronRight data-breadcrumb-separator-measure class="mx-0.5 h-3 w-3" />
			<span
				data-breadcrumb-overflow-measure
				class="inline-flex h-6 w-6 items-center justify-center"
			>
				<Ellipsis class="h-3.5 w-3.5" />
			</span>
		</div>
	</div>
</nav>
