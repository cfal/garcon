<script lang="ts">
	import Ellipsis from '@lucide/svelte/icons/ellipsis';
	import Maximize2 from '@lucide/svelte/icons/maximize-2';
	import PanelLeft from '@lucide/svelte/icons/panel-left';
	import PanelRight from '@lucide/svelte/icons/panel-right';
	import X from '@lucide/svelte/icons/x';
	import {
		DropdownMenu,
		DropdownMenuContent,
		DropdownMenuItem,
		DropdownMenuSeparator,
		DropdownMenuTrigger,
	} from '$lib/components/ui/dropdown-menu';
	import { getWorkspaceCoordinator } from '$lib/context';
	import type { HostId } from '$lib/workspace/surface-types.js';
	import * as m from '$lib/paraglide/messages.js';

	let {
		surfaceId,
		presentation,
		canPopOut = false,
	}: {
		surfaceId: string;
		presentation: HostId | 'mobile';
		canPopOut?: boolean;
	} = $props();

	const workspace = getWorkspaceCoordinator();
	const destination = $derived<HostId>(presentation === 'main' ? 'sidebar' : 'main');
	const moveLabel = $derived(
		presentation === 'main' ? m.workspace_move_to_sidebar() : m.workspace_move_to_main(),
	);
	const closeBlocked = $derived(workspace.isSurfaceCloseBlocked(surfaceId));
</script>

{#if presentation !== 'mobile'}
	<div class="surface-placement-wide flex shrink-0 items-center gap-1">
		{#if canPopOut}
			<button
				type="button"
				class="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
				onclick={() => void workspace.popOutFile(surfaceId)}
				aria-label={m.workspace_pop_out()}
				title={m.workspace_pop_out()}
			>
				<Maximize2 class="h-4 w-4" />
			</button>
		{/if}
		<button
			type="button"
			class="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
			onclick={() => void workspace.moveSurface(surfaceId, destination)}
			aria-label={moveLabel}
			title={moveLabel}
		>
			{#if destination === 'sidebar'}<PanelRight class="h-4 w-4" />{:else}<PanelLeft
					class="h-4 w-4"
				/>{/if}
		</button>
		<button
			type="button"
			class="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
			onclick={() => void workspace.closeSurface(surfaceId)}
			disabled={closeBlocked}
			aria-label={m.workspace_close_view()}
			title={m.workspace_close_view()}
		>
			<X class="h-4 w-4" />
		</button>
	</div>

	<div class="surface-placement-overflow hidden shrink-0">
		<DropdownMenu>
			<DropdownMenuTrigger
				class="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
				aria-label={m.workspace_surface_actions()}
				title={m.workspace_surface_actions()}
			>
				<Ellipsis class="h-4 w-4" />
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end">
				{#if canPopOut}
					<DropdownMenuItem onclick={() => void workspace.popOutFile(surfaceId)}>
						<Maximize2 />
						{m.workspace_pop_out()}
					</DropdownMenuItem>
				{/if}
				<DropdownMenuItem onclick={() => void workspace.moveSurface(surfaceId, destination)}>
					{#if destination === 'sidebar'}<PanelRight />{:else}<PanelLeft />{/if}
					{moveLabel}
				</DropdownMenuItem>
				<DropdownMenuSeparator />
				<DropdownMenuItem
					variant="destructive"
					disabled={closeBlocked}
					onclick={() => void workspace.closeSurface(surfaceId)}
				>
					<X />
					{m.workspace_close_view()}
				</DropdownMenuItem>
			</DropdownMenuContent>
		</DropdownMenu>
	</div>
{/if}

<style>
	@container surface-toolbar (max-width: 34rem) {
		.surface-placement-wide {
			display: none;
		}

		.surface-placement-overflow {
			display: flex;
		}
	}
</style>
