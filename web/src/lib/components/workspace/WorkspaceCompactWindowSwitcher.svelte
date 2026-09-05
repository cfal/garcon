<script lang="ts">
	import ChevronLeft from '@lucide/svelte/icons/chevron-left';
	import ChevronRight from '@lucide/svelte/icons/chevron-right';
	import CircleHelp from '@lucide/svelte/icons/circle-help';
	import PanelLeftClose from '@lucide/svelte/icons/panel-left-close';
	import X from '@lucide/svelte/icons/x';
	import {
		DropdownMenu,
		DropdownMenuContent,
		DropdownMenuItem,
		DropdownMenuLabel,
		DropdownMenuSeparator,
		DropdownMenuTrigger,
	} from '$lib/components/ui/dropdown-menu';
	import type {
		WorkspaceWindowId,
		WorkspaceWindowNode,
	} from '$lib/workspace/surface-types.js';
	import { WORKSPACE_COMPACT_SWITCHER_HEIGHT_PX } from './workspace-window-chrome.js';
	import * as m from '$lib/paraglide/messages.js';

	let {
		windows,
		currentWindowId,
		labelFor,
		showRecoveryHint,
		chatListConsumesWorkspaceWidth,
		canEnableChatListAutohide,
		onActivate,
		onDismissHint,
		onEnableChatListAutohide,
	}: {
		windows: readonly WorkspaceWindowNode[];
		currentWindowId: WorkspaceWindowId;
		labelFor(surfaceId: string): string;
		showRecoveryHint: boolean;
		chatListConsumesWorkspaceWidth: boolean;
		canEnableChatListAutohide: boolean;
		onActivate(windowId: WorkspaceWindowId): void;
		onDismissHint(): void;
		onEnableChatListAutohide(): void;
	} = $props();

	const currentIndex = $derived.by(() => {
		const index = windows.findIndex((workspaceWindow) => workspaceWindow.id === currentWindowId);
		return index < 0 ? 0 : index;
	});
	const currentWindow = $derived(windows[currentIndex] ?? null);
	const positionLabel = $derived(
		m.workspace_compact_window_position({ current: currentIndex + 1, count: windows.length }),
	);
	const recoveryHint = $derived(
		canEnableChatListAutohide
			? m.workspace_compact_recovery_hint()
			: m.workspace_compact_recovery_hint_resize(),
	);

	function activateAt(index: number): void {
		if (windows.length === 0) return;
		const destination = windows[(index + windows.length) % windows.length];
		if (destination) onActivate(destination.id);
	}
</script>

<nav
	data-workspace-compact-switcher
	aria-label={m.workspace_compact_window_list()}
	class="workspace-compact-switcher relative z-40 flex shrink-0 items-center gap-0.5 border-b border-border/60 bg-muted/40 px-1.5 text-xs"
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

	<DropdownMenu>
		<DropdownMenuTrigger
			class="h-7 shrink-0 rounded-md px-1.5 font-medium text-foreground hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
			aria-label={positionLabel}
			title={positionLabel}
			data-workspace-compact-window-list-trigger
		>
			{positionLabel}
		</DropdownMenuTrigger>
		<DropdownMenuContent
			align="start"
			class="w-72"
			data-workspace-compact-window-list
		>
			{#each windows as workspaceWindow, index (workspaceWindow.id)}
				{@const title = labelFor(workspaceWindow.tabs.activeId)}
				<DropdownMenuItem
					class="min-w-0"
					aria-current={workspaceWindow.id === currentWindowId ? 'true' : undefined}
					data-workspace-compact-window-id={workspaceWindow.id}
					onSelect={() => onActivate(workspaceWindow.id)}
				>
					<span class="w-5 shrink-0 text-end text-muted-foreground">{index + 1}</span>
					<span class="min-w-0 flex-1 truncate" title={title}>{title}</span>
				</DropdownMenuItem>
			{/each}
			{#if showRecoveryHint && chatListConsumesWorkspaceWidth}
				<DropdownMenuSeparator />
				<DropdownMenuLabel class="whitespace-normal text-xs font-normal text-muted-foreground">
					{recoveryHint}
				</DropdownMenuLabel>
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

	{#if currentWindow}
		<span class="compact-window-title min-w-0 flex-1 truncate px-1 text-muted-foreground">
			{labelFor(currentWindow.tabs.activeId)}
		</span>
	{/if}

	{#if showRecoveryHint && chatListConsumesWorkspaceWidth}
		<span
			class="compact-recovery-icon flex size-5 shrink-0 items-center justify-center text-muted-foreground"
			role="img"
			aria-label={recoveryHint}
			title={recoveryHint}
		>
			<CircleHelp class="size-3.5" aria-hidden="true" />
		</span>
		<span class="compact-recovery-text min-w-0 truncate text-muted-foreground" title={recoveryHint}>
			{recoveryHint}
		</span>
		{#if canEnableChatListAutohide}
			<button
				type="button"
				class="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
				aria-label={m.workspace_compact_enable_autohide()}
				title={m.workspace_compact_enable_autohide()}
				onclick={onEnableChatListAutohide}
			>
				<PanelLeftClose class="size-3.5" aria-hidden="true" />
			</button>
		{/if}
		<button
			type="button"
			class="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
			aria-label={m.workspace_compact_dismiss_hint()}
			title={m.workspace_compact_dismiss_hint()}
			onclick={onDismissHint}
		>
			<X class="size-3.5" aria-hidden="true" />
		</button>
	{/if}
</nav>

<style>
	.workspace-compact-switcher {
		container-name: workspace-compact-switcher;
		container-type: inline-size;
	}

	.compact-window-title,
	.compact-recovery-text {
		display: none;
	}

	@container workspace-compact-switcher (min-width: 32rem) {
		.compact-window-title {
			display: block;
		}
	}

	@container workspace-compact-switcher (min-width: 48rem) {
		.compact-recovery-icon {
			display: none;
		}

		.compact-recovery-text {
			display: block;
		}
	}
</style>
