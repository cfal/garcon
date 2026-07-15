<script lang="ts">
	import { untrack, type Component, type Snippet } from 'svelte';
	import Ellipsis from '@lucide/svelte/icons/ellipsis';
	import {
		DropdownMenu,
		DropdownMenuContent,
		DropdownMenuItem,
		DropdownMenuTrigger,
	} from '$lib/components/ui/dropdown-menu';
	import { cn } from '$lib/utils/cn';
	import { selectVisibleSurfaceActionIds } from './responsive-surface-actions.js';

	export interface ResponsiveSurfaceAction {
		id: string;
		label: string;
		title?: string;
		icon: Component<{ class?: string }>;
		onclick: () => void;
		disabled?: boolean;
		busy?: boolean;
		priority?: number;
		showLabel?: boolean;
		variant?: 'ghost' | 'primary' | 'destructive';
		iconClass?: string;
	}

	let {
		actions,
		menuLabel,
		menuContent,
		fixed,
		class: className,
	}: {
		actions: readonly ResponsiveSurfaceAction[];
		menuLabel: string;
		menuContent?: Snippet<[readonly ResponsiveSurfaceAction[]]>;
		fixed?: Snippet;
		class?: string;
	} = $props();

	const gap = 4;
	let root = $state<HTMLDivElement | null>(null);
	let fixedControl = $state<HTMLDivElement | null>(null);
	let measurementRail = $state<HTMLDivElement | null>(null);
	let visibleActionIds = $state.raw<ReadonlySet<string> | null>(null);
	const visibleActions = $derived(
		actions.filter((action) =>
			(visibleActionIds ?? new Set(actions.map(({ id }) => id))).has(action.id),
		),
	);
	const overflowActions = $derived(
		actions.filter(
			(action) => !(visibleActionIds ?? new Set(actions.map(({ id }) => id))).has(action.id),
		),
	);
	const showMenu = $derived(Boolean(menuContent) || overflowActions.length > 0);

	function actionClass(action: ResponsiveSurfaceAction): string {
		return cn(
			'inline-flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-md px-2 text-xs font-medium transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50 aria-disabled:pointer-events-none aria-disabled:opacity-50',
			action.showLabel ? '' : 'w-8 px-0',
			action.variant === 'primary' &&
				'bg-interactive-accent text-interactive-accent-foreground hover:brightness-110',
			action.variant === 'destructive' &&
				'text-destructive hover:bg-destructive/10 hover:text-destructive',
			(!action.variant || action.variant === 'ghost') &&
				'text-muted-foreground hover:bg-accent hover:text-foreground',
		);
	}

	function recompute(): void {
		const actionRoot = root;
		const rail = measurementRail;
		if (!actionRoot || !rail) return;
		const widths = new Map<string, number>();
		for (const element of rail.querySelectorAll<HTMLElement>('[data-surface-action-measure]')) {
			const id = element.dataset.surfaceActionMeasure;
			if (id) widths.set(id, element.getBoundingClientRect().width);
		}
		const menuButtonWidth =
			rail
				.querySelector<HTMLElement>('[data-surface-action-overflow-measure]')
				?.getBoundingClientRect().width ?? 0;
		const fixedWidth = fixedControl?.getBoundingClientRect().width ?? 0;
		const fixedGap = fixedWidth > 0 && (actions.length > 0 || Boolean(menuContent)) ? gap : 0;
		visibleActionIds = selectVisibleSurfaceActionIds({
			actions: actions.map(({ id, priority = 100 }) => ({ id, priority })),
			availableWidth: Math.max(0, actionRoot.clientWidth - fixedWidth - fixedGap),
			widths,
			menuButtonWidth,
			menuVisibility: menuContent ? 'persistent' : 'overflow',
			gap,
		});
	}

	$effect(() => {
		const actionRoot = root;
		const rail = measurementRail;
		if (!actionRoot || !rail || typeof ResizeObserver === 'undefined') return;
		const observer = new ResizeObserver(recompute);
		observer.observe(actionRoot);
		observer.observe(rail);
		if (fixedControl) observer.observe(fixedControl);
		for (const element of rail.querySelectorAll<HTMLElement>('[data-surface-action-measure]')) {
			observer.observe(element);
		}
		queueMicrotask(recompute);
		return () => observer.disconnect();
	});

	$effect(() => {
		actions
			.map(
				({ id, label, title, disabled, busy, priority, showLabel, variant, iconClass }) =>
					`${id}:${label}:${title}:${disabled}:${busy}:${priority}:${showLabel}:${variant}:${iconClass}`,
			)
			.join('|');
		untrack(() => queueMicrotask(recompute));
	});
</script>

{#snippet actionButton(action: ResponsiveSurfaceAction, measurement = false)}
	{@const Icon = action.icon}
	<button
		type="button"
		class={actionClass(action)}
		onclick={measurement || action.busy ? undefined : action.onclick}
		disabled={action.disabled}
		aria-disabled={action.busy || undefined}
		aria-busy={action.busy || undefined}
		tabindex={measurement ? -1 : undefined}
		aria-label={action.title ?? action.label}
		title={action.title ?? action.label}
		data-surface-action-id={measurement ? undefined : action.id}
		data-surface-action-measure={measurement ? action.id : undefined}
	>
		<Icon class={cn('h-4 w-4', action.iconClass)} />
		{#if action.showLabel}<span class="min-w-0 truncate">{action.label}</span>{/if}
	</button>
{/snippet}

<div
	bind:this={root}
	class={cn(
		'relative flex min-w-8 flex-1 items-center justify-end gap-1 overflow-hidden',
		className,
	)}
	data-responsive-surface-actions
>
	{#if fixed}
		<div bind:this={fixedControl} class="flex min-w-0 shrink items-center gap-1">
			{@render fixed()}
		</div>
	{/if}
	{#each visibleActions as action (action.id)}
		{@render actionButton(action)}
	{/each}
	{#if showMenu}
		<DropdownMenu>
			<DropdownMenuTrigger
				class="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
				aria-label={menuLabel}
				title={menuLabel}
				data-responsive-surface-menu-trigger
			>
				<Ellipsis class="h-4 w-4" />
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end" class={menuContent ? 'w-64' : 'w-56'}>
				{#if menuContent}
					{@render menuContent(overflowActions)}
				{:else}
					{#each overflowActions as action (action.id)}
						{@const Icon = action.icon}
						<DropdownMenuItem
							variant={action.variant === 'destructive' ? 'destructive' : undefined}
							disabled={action.disabled || action.busy}
							aria-busy={action.busy || undefined}
							onclick={action.onclick}
						>
							<Icon class={cn('h-4 w-4', action.iconClass)} />
							<span class="min-w-0 truncate">{action.label}</span>
						</DropdownMenuItem>
					{/each}
				{/if}
			</DropdownMenuContent>
		</DropdownMenu>
	{/if}

	<div
		bind:this={measurementRail}
		class="pointer-events-none invisible absolute -left-[10000px] top-0 flex items-center gap-1"
		aria-hidden="true"
	>
		{#each actions as action (action.id)}
			{@render actionButton(action, true)}
		{/each}
		<button
			type="button"
			tabindex="-1"
			class="inline-flex h-8 w-8 items-center justify-center rounded-md"
			data-surface-action-overflow-measure
		>
			<Ellipsis class="h-4 w-4" />
		</button>
	</div>
</div>
