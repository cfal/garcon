<script lang="ts">
	import * as m from '$lib/paraglide/messages.js';
	import { cn } from '$lib/utils/cn';
	import Pin from '@lucide/svelte/icons/pin';
	import Archive from '@lucide/svelte/icons/archive';
	import Edit2 from '@lucide/svelte/icons/pencil';
	import Trash2 from '@lucide/svelte/icons/trash-2';
	import ArrowUpToLine from '@lucide/svelte/icons/arrow-up-to-line';
	import ArrowDownToLine from '@lucide/svelte/icons/arrow-down-to-line';
	import Info from '@lucide/svelte/icons/info';
	import GitFork from '@lucide/svelte/icons/git-fork';
	import Share2 from '@lucide/svelte/icons/share-2';
	import Tag from '@lucide/svelte/icons/tag';
	import CheckSquare from '@lucide/svelte/icons/check-square';
	import PanelRight from '@lucide/svelte/icons/panel-right';
	import PanelTop from '@lucide/svelte/icons/panel-top';
	import ArrowUpDown from '@lucide/svelte/icons/arrow-up-down';
	import CalendarClock from '@lucide/svelte/icons/calendar-clock';
	import History from '@lucide/svelte/icons/history';
	import {
		DropdownMenuItem,
		DropdownMenuSeparator,
		DropdownMenuSub,
		DropdownMenuSubContent,
		DropdownMenuSubTrigger,
	} from '$lib/components/ui/dropdown-menu';
	import type { ChatSessionRecord } from '$lib/types/chat-session';
	import {
		WORKSPACE_WINDOW_EDGES,
		type WorkspaceWindowEdge,
	} from '$lib/workspace/surface-types.js';
	import type { WorkspaceSplitAdmissions } from '$lib/workspace/window-geometry-policy.js';
	import { workspaceSplitBlockMessage } from '$lib/workspace/workspace-split-blocked-error.js';
	import type { ChatOrderSortKey } from '$shared/chat-order-sort';

	interface SidebarChatMenuProps {
		session: ChatSessionRecord;
		isPinned: boolean;
		isArchived: boolean;
		canFork: boolean;
		canForkNow: boolean;
		onEnterMultiSelect?: (chatId: string) => void;
		onMoveToTop?: () => void;
		onMoveToBottom?: () => void;
		onSortChatOrder?: (sortKey: ChatOrderSortKey) => void;
		onOpenInNewWindow?: (chatId: string, edge?: WorkspaceWindowEdge) => void;
		newWindowEdges: WorkspaceSplitAdmissions;
		onTogglePinned: (chatId: string) => void;
		onToggleArchive: (chatId: string) => void;
		onRename: () => void;
		onDetails: () => void;
		onShare: () => void;
		onManageTags?: () => void;
		onFork: () => void;
		onDelete: () => void;
	}

	let {
		session,
		isPinned,
		isArchived,
		canFork,
		canForkNow,
		onEnterMultiSelect,
		onMoveToTop,
		onMoveToBottom,
		onSortChatOrder,
		onOpenInNewWindow,
		newWindowEdges,
		onTogglePinned,
		onToggleArchive,
		onRename,
		onDetails,
		onShare,
		onManageTags,
		onFork,
		onDelete,
	}: SidebarChatMenuProps = $props();

	const hasSidebarActions = $derived(
		Boolean(onEnterMultiSelect || onMoveToTop || onMoveToBottom || onSortChatOrder),
	);
	const canOpenInNewWindow = $derived(
		WORKSPACE_WINDOW_EDGES.some((edge) => newWindowEdges[edge]?.allowed === true),
	);
	const newWindowBlockTitle = $derived.by(() => {
		if (canOpenInNewWindow) return undefined;
		for (const edge of WORKSPACE_WINDOW_EDGES) {
			const admission = newWindowEdges[edge];
			if (admission && !admission.allowed) {
				return workspaceSplitBlockMessage(admission.reason);
			}
		}
		return undefined;
	});

	function edgeLabel(edge: WorkspaceWindowEdge): string {
		switch (edge) {
			case 'left':
				return m.workspace_open_new_window_left();
			case 'right':
				return m.workspace_open_new_window_right();
			case 'top':
				return m.workspace_open_new_window_above();
			case 'bottom':
				return m.workspace_open_new_window_below();
		}
	}
</script>

{#if hasSidebarActions}
	{#if onEnterMultiSelect}
		<DropdownMenuItem onclick={() => onEnterMultiSelect?.(session.id)}>
			<CheckSquare />
			{m.sidebar_select_enter()}
		</DropdownMenuItem>
	{/if}
	{#if onMoveToTop}
		<DropdownMenuItem onclick={onMoveToTop}>
			<ArrowUpToLine />
			{m.sidebar_chats_move_to_top()}
		</DropdownMenuItem>
	{/if}
	{#if onMoveToBottom}
		<DropdownMenuItem onclick={onMoveToBottom}>
			<ArrowDownToLine />
			{m.sidebar_chats_move_to_bottom()}
		</DropdownMenuItem>
	{/if}
	{#if onSortChatOrder}
		<DropdownMenuSub>
			<DropdownMenuSubTrigger>
				<ArrowUpDown />
				{m.sidebar_chats_reorder()}
			</DropdownMenuSubTrigger>
			<DropdownMenuSubContent class="w-56">
				<DropdownMenuItem onclick={() => onSortChatOrder?.('created')}>
					<CalendarClock />
					{m.sidebar_chats_reorder_by_creation()}
				</DropdownMenuItem>
				<DropdownMenuItem onclick={() => onSortChatOrder?.('activity')}>
					<History />
					{m.sidebar_chats_reorder_by_activity()}
				</DropdownMenuItem>
			</DropdownMenuSubContent>
		</DropdownMenuSub>
	{/if}
	<DropdownMenuSeparator />
{/if}

{#if onOpenInNewWindow}
	<DropdownMenuSub>
		<DropdownMenuSubTrigger disabled={!canOpenInNewWindow} title={newWindowBlockTitle}>
			<PanelRight />
			{m.sidebar_chat_open_new_window()}
		</DropdownMenuSubTrigger>
		<DropdownMenuSubContent class="w-56">
			{#each WORKSPACE_WINDOW_EDGES as edge (edge)}
				{@const admission = newWindowEdges[edge]}
				<DropdownMenuItem
					disabled={admission?.allowed !== true}
					title={admission && !admission.allowed
						? workspaceSplitBlockMessage(admission.reason)
						: undefined}
					onclick={() => {
						if (admission?.allowed) onOpenInNewWindow?.(session.id, edge);
					}}
				>
					{#if edge === 'left'}
						<PanelRight class="rotate-180" />
					{:else if edge === 'right'}
						<PanelRight />
					{:else if edge === 'top'}
						<PanelTop />
					{:else}
						<PanelTop class="rotate-180" />
					{/if}
					{edgeLabel(edge)}
				</DropdownMenuItem>
			{/each}
		</DropdownMenuSubContent>
	</DropdownMenuSub>
	<DropdownMenuSeparator />
{/if}

<DropdownMenuItem onclick={() => onTogglePinned(session.id)}>
	<Pin />
	{isPinned ? m.sidebar_chats_unpin() : m.sidebar_chats_pin()}
</DropdownMenuItem>
<DropdownMenuItem onclick={() => onToggleArchive(session.id)}>
	<Archive class={cn(isArchived ? 'text-muted-foreground' : '')} />
	{isArchived ? m.sidebar_chats_unarchive() : m.sidebar_chats_archive()}
</DropdownMenuItem>
<DropdownMenuSeparator />
<DropdownMenuItem onclick={onShare}>
	<Share2 />
	{m.share_button()}
</DropdownMenuItem>
<DropdownMenuItem onclick={onDetails}>
	<Info />
	{m.sidebar_chats_details()}
</DropdownMenuItem>
{#if canFork}
	<DropdownMenuItem
		disabled={!canForkNow}
		onclick={() => {
			if (canForkNow) onFork();
		}}
	>
		<GitFork />
		{m.sidebar_chats_fork()}
	</DropdownMenuItem>
{/if}
<DropdownMenuItem onclick={onRename}>
	<Edit2 />
	{m.sidebar_tooltips_edit_chat_name()}
</DropdownMenuItem>
{#if onManageTags}
	<DropdownMenuItem onclick={onManageTags}>
		<Tag />
		{m.sidebar_tags_manage()}
	</DropdownMenuItem>
{/if}
<DropdownMenuSeparator />
<DropdownMenuItem variant="destructive" onclick={onDelete}>
	<Trash2 />
	{m.sidebar_tooltips_delete_chat()}
</DropdownMenuItem>
