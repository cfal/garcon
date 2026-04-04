<script lang="ts">
	import * as Dialog from '$lib/components/ui/dialog';
	import { Button } from '$lib/components/ui/button';
	import * as m from '$lib/paraglide/messages.js';
	import { cn } from '$lib/utils/cn';
	import Plus from '@lucide/svelte/icons/plus';
	import Pencil from '@lucide/svelte/icons/pencil';
	import Trash2 from '@lucide/svelte/icons/trash-2';
	import GripVertical from '@lucide/svelte/icons/grip-vertical';
	import ChevronUp from '@lucide/svelte/icons/chevron-up';
	import ChevronDown from '@lucide/svelte/icons/chevron-down';
	import type { SavedChatSearch } from '$lib/api/settings';

	interface SavedSearchManagerDialogProps {
		open: boolean;
		searches: SavedChatSearch[];
		onClose: () => void;
		onAdd: () => void;
		onEdit: (search: SavedChatSearch) => void;
		onDelete: (id: string) => void;
		onReorder: (oldOrder: string[], newOrder: string[]) => void;
	}

	let {
		open,
		searches,
		onClose,
		onAdd,
		onEdit,
		onDelete,
		onReorder,
	}: SavedSearchManagerDialogProps = $props();

	let draggedId = $state<string | null>(null);
	let dragOverId = $state<string | null>(null);

	function handleOpenChange(nextOpen: boolean) {
		if (!nextOpen) onClose();
	}

	function handleDragStart(e: DragEvent, id: string) {
		draggedId = id;
		if (e.dataTransfer) {
			e.dataTransfer.effectAllowed = 'move';
			e.dataTransfer.setData('text/plain', id);
		}
	}

	function handleDragOver(e: DragEvent, id: string) {
		e.preventDefault();
		if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
		dragOverId = id;
	}

	function handleDragLeave() {
		dragOverId = null;
	}

	function handleDrop(e: DragEvent, targetId: string) {
		e.preventDefault();
		dragOverId = null;
		if (!draggedId || draggedId === targetId) {
			draggedId = null;
			return;
		}
		const oldOrder = searches.map((s) => s.id);
		const fromIdx = oldOrder.indexOf(draggedId);
		const toIdx = oldOrder.indexOf(targetId);
		if (fromIdx < 0 || toIdx < 0) {
			draggedId = null;
			return;
		}
		const newOrder = [...oldOrder];
		newOrder.splice(fromIdx, 1);
		newOrder.splice(toIdx, 0, draggedId);
		onReorder(oldOrder, newOrder);
		draggedId = null;
	}

	function handleDragEnd() {
		draggedId = null;
		dragOverId = null;
	}

	function moveSearch(searchId: string, direction: -1 | 1) {
		const oldOrder = searches.map((search) => search.id);
		const fromIndex = oldOrder.indexOf(searchId);
		if (fromIndex < 0) return;

		const toIndex = fromIndex + direction;
		if (toIndex < 0 || toIndex >= oldOrder.length) return;

		const newOrder = [...oldOrder];
		const [movedId] = newOrder.splice(fromIndex, 1);
		if (!movedId) return;
		newOrder.splice(toIndex, 0, movedId);
		onReorder(oldOrder, newOrder);
	}
</script>

<Dialog.Root {open} onOpenChange={handleOpenChange}>
	<Dialog.Content class="h-dvh w-full max-w-full rounded-none border-0 p-6 sm:h-auto sm:max-w-md sm:rounded-lg sm:border">
		<Dialog.Header>
			<Dialog.Title>{m.sidebar_saved_searches_manage_title()}</Dialog.Title>
		</Dialog.Header>

		<div class="space-y-1 min-h-[100px] max-h-[50vh] overflow-y-auto">
			{#if searches.length === 0}
				<div class="py-8 text-center text-sm text-muted-foreground">
					{m.sidebar_saved_searches_empty()}
				</div>
			{:else}
				{#each searches as search, i (search.id)}
						<div
							class={cn(
								'group flex items-center gap-2 rounded-md px-2 py-1.5 transition-colors',
							dragOverId === search.id ? 'bg-accent/50' : 'hover:bg-accent/30',
						)}
						draggable="true"
						ondragstart={(e) => handleDragStart(e, search.id)}
						ondragover={(e) => handleDragOver(e, search.id)}
						ondragleave={handleDragLeave}
						ondrop={(e) => handleDrop(e, search.id)}
						ondragend={handleDragEnd}
						role="listitem"
					>
						<GripVertical class="w-3.5 h-3.5 text-muted-foreground/50 shrink-0 cursor-grab" />
							<div class="flex-1 min-w-0">
								<div class="text-sm font-medium truncate">{search.title || search.query}</div>
								{#if search.title}
									<div class="text-xs text-muted-foreground truncate">{search.query}</div>
								{/if}
								<div class="flex flex-wrap gap-1 pt-1">
									{#if search.showAsSidebarPill}
										<span class="rounded border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground">Pill</span>
									{/if}
									{#if search.showInSidebarMenu}
										<span class="rounded border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground">Menu</span>
									{/if}
									{#if search.showInSearchDialog}
										<span class="rounded border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground">Dialog</span>
									{/if}
								</div>
							</div>
							<div class="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity shrink-0">
								<button
									type="button"
									class="p-1 rounded hover:bg-accent text-muted-foreground hover:text-foreground transition-colors disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-muted-foreground"
									onclick={() => moveSearch(search.id, -1)}
									aria-label={`Move ${search.title || search.query} up`}
									disabled={i === 0}
								>
									<ChevronUp class="w-3.5 h-3.5" />
								</button>
								<button
									type="button"
									class="p-1 rounded hover:bg-accent text-muted-foreground hover:text-foreground transition-colors disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-muted-foreground"
									onclick={() => moveSearch(search.id, 1)}
									aria-label={`Move ${search.title || search.query} down`}
									disabled={i === searches.length - 1}
								>
									<ChevronDown class="w-3.5 h-3.5" />
								</button>
								<button
									type="button"
									class="p-1 rounded hover:bg-accent text-muted-foreground hover:text-foreground transition-colors"
								onclick={() => onEdit(search)}
								aria-label={m.sidebar_saved_searches_edit()}
							>
								<Pencil class="w-3.5 h-3.5" />
							</button>
							<button
								type="button"
								class="p-1 rounded hover:bg-destructive/10 text-muted-foreground hover:text-destructive transition-colors"
								onclick={() => onDelete(search.id)}
								aria-label={m.sidebar_actions_delete()}
							>
								<Trash2 class="w-3.5 h-3.5" />
							</button>
						</div>
					</div>
				{/each}
			{/if}
		</div>

		<Dialog.Footer>
			<Button variant="outline" onclick={onAdd}>
				<Plus class="w-3.5 h-3.5 mr-1.5" />
				{m.sidebar_saved_searches_add()}
			</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
