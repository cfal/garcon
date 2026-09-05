<script lang="ts">
	import ChevronLeft from '@lucide/svelte/icons/chevron-left';
	import ChevronRight from '@lucide/svelte/icons/chevron-right';
	import {
		DropdownMenu,
		DropdownMenuContent,
		DropdownMenuItem,
		DropdownMenuLabel,
		DropdownMenuSeparator,
		DropdownMenuTrigger,
	} from '$lib/components/ui/dropdown-menu';
	import { onDestroy } from 'svelte';
	import * as m from '$lib/paraglide/messages.js';
	import type { WorkspaceWindowId, WorkspaceWindowNode } from '$lib/workspace/surface-types.js';
	import { WORKSPACE_COMPACT_SWITCHER_HEIGHT_PX } from './workspace-window-chrome.js';

	let {
		windows,
		currentWindowId,
		labelFor,
		chatListConsumesWorkspaceWidth,
		canEnableChatListAutohide,
		onActivate,
		onExitNavigation,
		onEnableChatListAutohide,
	}: {
		windows: readonly WorkspaceWindowNode[];
		currentWindowId: WorkspaceWindowId;
		labelFor(surfaceId: string): string;
		chatListConsumesWorkspaceWidth: boolean;
		canEnableChatListAutohide: boolean;
		onActivate(windowId: WorkspaceWindowId): void;
		onExitNavigation(): void;
		onEnableChatListAutohide(): void;
	} = $props();

	let navigation: HTMLElement | undefined = $state();
	let menuOpen = $state(false);
	let navigationOwnsFocus = false;
	const currentIndex = $derived(
		Math.max(
			0,
			windows.findIndex((item) => item.id === currentWindowId),
		),
	);
	const currentWindow = $derived(windows[currentIndex]);
	const positionLabel = $derived(
		m.workspace_compact_window_position({ current: currentIndex + 1, count: windows.length }),
	);

	function activateAt(index: number): void {
		if (windows.length === 0) return;
		const destination = windows[(index + windows.length) % windows.length];
		if (destination) onActivate(destination.id);
	}

	// Transfers focus only when navigation disappears, not on window switches.
	onDestroy(() => {
		if (menuOpen || navigationOwnsFocus) onExitNavigation();
	});
</script>

<nav
	bind:this={navigation}
	onfocusin={() => {
		navigationOwnsFocus = true;
	}}
	onfocusout={(event) => {
		if (event.relatedTarget instanceof Node) {
			navigationOwnsFocus = navigation?.contains(event.relatedTarget) ?? false;
		}
	}}
	data-workspace-compact-switcher
	aria-label={m.workspace_compact_window_list()}
	class="workspace-compact-switcher flex min-w-0 items-center gap-1 border-b border-border/60 bg-muted px-1.5 text-xs"
	style:height={`${WORKSPACE_COMPACT_SWITCHER_HEIGHT_PX}px`}
>
	<button
		type="button"
		class="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
		aria-label={m.workspace_compact_previous_window()}
		title={m.workspace_compact_previous_window()}
		onclick={() => activateAt(currentIndex - 1)}
	>
		<ChevronLeft class="size-3.5" aria-hidden="true" />
	</button>
	<DropdownMenu bind:open={menuOpen}>
		<DropdownMenuTrigger
			class="flex h-7 min-w-0 flex-1 items-center gap-2 rounded-md px-1.5 text-foreground hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
			aria-label={positionLabel}
			title={positionLabel}
			data-workspace-compact-window-list-trigger
		>
			<span class="min-w-0 truncate font-medium">
				{currentWindow ? labelFor(currentWindow.tabs.activeId) : m.workspace_compact_window_list()}
			</span>
			<span class="shrink-0 text-muted-foreground">{positionLabel}</span>
		</DropdownMenuTrigger>
		<DropdownMenuContent align="start" class="w-72" data-workspace-compact-window-list>
			{#each windows as workspaceWindow (workspaceWindow.id)}
				{@const title = labelFor(workspaceWindow.tabs.activeId)}
				<DropdownMenuItem
					class="min-w-0"
					aria-current={workspaceWindow.id === currentWindowId ? 'true' : undefined}
					data-workspace-compact-window-id={workspaceWindow.id}
					onSelect={() => onActivate(workspaceWindow.id)}
				>
					<span class="min-w-0 flex-1 truncate" {title}>{title}</span>
				</DropdownMenuItem>
			{/each}
			<DropdownMenuSeparator />
			<DropdownMenuLabel class="whitespace-normal text-xs font-normal text-muted-foreground">
				{m.workspace_compact_recovery_hint_resize()}
			</DropdownMenuLabel>
			{#if chatListConsumesWorkspaceWidth && canEnableChatListAutohide}
				<DropdownMenuItem onSelect={onEnableChatListAutohide}>
					{m.workspace_compact_enable_autohide()}
				</DropdownMenuItem>
			{/if}
		</DropdownMenuContent>
	</DropdownMenu>
	<button
		type="button"
		class="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
		aria-label={m.workspace_compact_next_window()}
		title={m.workspace_compact_next_window()}
		onclick={() => activateAt(currentIndex + 1)}
	>
		<ChevronRight class="size-3.5" aria-hidden="true" />
	</button>
</nav>
