<script lang="ts">
	import Columns3 from '@lucide/svelte/icons/columns-3';
	import Settings2 from '@lucide/svelte/icons/settings-2';
	import SlidersHorizontal from '@lucide/svelte/icons/sliders-horizontal';
	import ChevronDown from '@lucide/svelte/icons/chevron-down';
	import Plus from '@lucide/svelte/icons/plus';
	import {
		DropdownMenu,
		DropdownMenuContent,
		DropdownMenuLabel,
		DropdownMenuItem,
		DropdownMenuRadioGroup,
		DropdownMenuRadioItem,
		DropdownMenuSeparator,
		DropdownMenuTrigger,
	} from '$lib/components/ui/dropdown-menu';
	import { Button } from '$lib/components/ui/button';
	import type { ChatBoard } from '$shared/chat-boards';
	import type { ChatItemLayout } from '$lib/layout/chat-item-layout.js';
	import * as m from '$lib/paraglide/messages.js';

	let {
		boards,
		selectedBoard,
		itemLayout,
		onSelectBoard,
		onEditColumns,
		onCreateBoard,
		onManageBoards,
		onSetLayout,
	}: {
		boards: readonly ChatBoard[];
		selectedBoard: ChatBoard | null;
		itemLayout: ChatItemLayout;
		onSelectBoard: (boardId: string) => void;
		onEditColumns: () => void;
		onCreateBoard: () => void;
		onManageBoards: () => void;
		onSetLayout: (layout: ChatItemLayout) => void;
	} = $props();

	const layoutLabels: Record<ChatItemLayout, () => string> = {
		detailed: m.chat_board_layout_detailed,
		compact: m.chat_board_layout_compact,
		'single-line': m.chat_board_layout_single_line,
	};
</script>

<header class="shrink-0 border-b border-border/80 bg-card/95 px-3 py-2.5 backdrop-blur sm:px-4">
	<div class="flex min-w-0 flex-wrap items-center gap-2">
		<div class="mr-auto flex min-w-0 items-center gap-2.5">
			<div
				class="grid size-8 shrink-0 place-items-center rounded-lg bg-accent text-accent-foreground"
			>
				<Columns3 class="size-4" aria-hidden="true" />
			</div>
			<div class="min-w-0">
				<h1 class="truncate text-sm font-semibold tracking-tight">
					{m.workspace_surface_chat_board()}
				</h1>
				<p class="hidden truncate text-[11px] text-muted-foreground sm:block">
					{m.chat_board_description()}
				</p>
			</div>
		</div>

		{#if selectedBoard}
			<DropdownMenu>
				<DropdownMenuTrigger
					class="inline-flex h-8 min-w-36 max-w-64 flex-1 items-center gap-2 rounded-md border border-border bg-background px-2.5 text-xs font-medium text-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring sm:flex-none"
					data-chat-board-selector
				>
					<span class="min-w-0 flex-1 truncate text-left" title={selectedBoard.name}
						>{selectedBoard.name}</span
					>
					<ChevronDown class="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
				</DropdownMenuTrigger>
				<DropdownMenuContent align="end" class="w-64">
					<DropdownMenuLabel>{m.chat_board_select_board()}</DropdownMenuLabel>
					<DropdownMenuRadioGroup value={selectedBoard.id} onValueChange={onSelectBoard}>
						{#each boards as board (board.id)}
							<DropdownMenuRadioItem value={board.id} title={board.name}>
								<span class="truncate">{board.name}</span>
							</DropdownMenuRadioItem>
						{/each}
					</DropdownMenuRadioGroup>
					<DropdownMenuSeparator />
					<DropdownMenuItem onSelect={onCreateBoard}>
						<Plus class="size-4" aria-hidden="true" />
						{m.chat_board_create_board()}
					</DropdownMenuItem>
					<DropdownMenuItem onSelect={onManageBoards}>
						<Settings2 class="size-4" aria-hidden="true" />
						{m.chat_board_manage_boards()}
					</DropdownMenuItem>
				</DropdownMenuContent>
			</DropdownMenu>
			<Button
				variant="outline"
				size="sm"
				class="h-8 gap-1.5"
				aria-label={m.chat_board_edit_columns()}
				title={m.chat_board_edit_columns()}
				onclick={onEditColumns}
			>
				<Settings2 class="size-3.5" aria-hidden="true" />
				<span class="hidden sm:inline">{m.chat_board_edit_columns()}</span>
			</Button>
		{/if}

		<DropdownMenu>
			<DropdownMenuTrigger
				class="inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-background px-2.5 text-xs font-medium text-foreground hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
				aria-label={m.chat_board_view()}
				title={m.chat_board_view()}
			>
				<SlidersHorizontal class="size-3.5" aria-hidden="true" />
				<span class="hidden sm:inline">{m.chat_board_view()}</span>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end" class="w-48">
				<DropdownMenuLabel>{m.chat_board_view()}</DropdownMenuLabel>
				<DropdownMenuRadioGroup
					value={itemLayout}
					onValueChange={(value) => onSetLayout(value as ChatItemLayout)}
				>
					{#each ['detailed', 'compact', 'single-line'] as layout (layout)}
						<DropdownMenuRadioItem value={layout}>
							{layoutLabels[layout as ChatItemLayout]()}
						</DropdownMenuRadioItem>
					{/each}
				</DropdownMenuRadioGroup>
			</DropdownMenuContent>
		</DropdownMenu>
	</div>
</header>
