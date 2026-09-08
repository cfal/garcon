<script lang="ts">
	import ArrowDown from '@lucide/svelte/icons/arrow-down';
	import ArrowUp from '@lucide/svelte/icons/arrow-up';
	import GripVertical from '@lucide/svelte/icons/grip-vertical';
	import Pencil from '@lucide/svelte/icons/pencil';
	import Trash2 from '@lucide/svelte/icons/trash-2';
	import * as Dialog from '$lib/components/ui/dialog';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import type { ChatBoardController } from '$lib/chat-board/catalog/chat-board-controller.svelte.js';
	import type { ChatBoard } from '$shared/chat-boards';
	import * as m from '$lib/paraglide/messages.js';

	let {
		open,
		controller,
		onClose,
		onEditBoard,
	}: {
		open: boolean;
		controller: ChatBoardController;
		onClose: () => void;
		onEditBoard: (board: ChatBoard) => void;
	} = $props();

	let newName = $state('');
	let editingId = $state<string | null>(null);
	let editingName = $state('');
	let deletingId = $state<string | null>(null);
	let busy = $state(false);
	let error = $state<string | null>(null);
	let draggedId = $state<string | null>(null);
	let dragOverId = $state<string | null>(null);
	let pendingCreatedBoardId = $state<string | null>(null);

	$effect(() => {
		if (!pendingCreatedBoardId) return;
		const board = controller.catalog.boards.find(
			(candidate) => candidate.id === pendingCreatedBoardId,
		);
		if (!board) return;
		pendingCreatedBoardId = null;
		onEditBoard(board);
	});

	function presentError(value: unknown): string {
		return value instanceof Error && value.message ? value.message : m.chat_board_save_failed();
	}

	async function createBoard(): Promise<void> {
		const name = newName.trim();
		if (!name || busy || pendingCreatedBoardId) {
			if (!name) error = m.chat_board_name_required();
			return;
		}
		busy = true;
		error = null;
		try {
			const id = await controller.createBoard(name);
			newName = '';
			pendingCreatedBoardId = id;
		} catch (value) {
			error = presentError(value);
		} finally {
			busy = false;
		}
	}

	function startRename(board: ChatBoard): void {
		editingId = board.id;
		editingName = board.name;
		deletingId = null;
	}

	async function saveRename(board: ChatBoard): Promise<void> {
		const name = editingName.trim();
		if (!name || busy) {
			if (!name) error = m.chat_board_name_required();
			return;
		}
		busy = true;
		error = null;
		try {
			await controller.updateBoard({ ...board, name });
			editingId = null;
		} catch (value) {
			error = presentError(value);
		} finally {
			busy = false;
		}
	}

	async function commitOrder(ids: readonly string[]): Promise<void> {
		if (busy) return;
		busy = true;
		error = null;
		try {
			await controller.reorderBoards(ids);
		} catch (value) {
			error = presentError(value);
		} finally {
			busy = false;
		}
	}

	async function move(board: ChatBoard, offset: -1 | 1): Promise<void> {
		const ids = controller.catalog.boards.map((candidate) => candidate.id);
		const index = ids.indexOf(board.id);
		const target = index + offset;
		if (index < 0 || target < 0 || target >= ids.length || busy) return;
		[ids[index], ids[target]] = [ids[target], ids[index]];
		await commitOrder(ids);
	}

	function handleDragStart(event: DragEvent, boardId: string): void {
		if (busy) {
			event.preventDefault();
			return;
		}
		draggedId = boardId;
		event.dataTransfer?.setData('text/plain', boardId);
		if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
	}

	function handleDragOver(event: DragEvent, boardId: string): void {
		if (!draggedId || draggedId === boardId || busy) return;
		event.preventDefault();
		dragOverId = boardId;
		if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
	}

	function handleDrop(event: DragEvent, targetId: string): void {
		event.preventDefault();
		const sourceId = draggedId;
		draggedId = null;
		dragOverId = null;
		if (!sourceId || sourceId === targetId || busy) return;
		const ids = controller.catalog.boards.map((candidate) => candidate.id);
		const sourceIndex = ids.indexOf(sourceId);
		const targetIndex = ids.indexOf(targetId);
		if (sourceIndex < 0 || targetIndex < 0) return;
		ids.splice(sourceIndex, 1);
		ids.splice(targetIndex, 0, sourceId);
		void commitOrder(ids);
	}

	function clearDrag(): void {
		draggedId = null;
		dragOverId = null;
	}

	async function removeBoard(board: ChatBoard): Promise<void> {
		if (deletingId !== board.id || busy) {
			deletingId = board.id;
			editingId = null;
			return;
		}
		busy = true;
		error = null;
		try {
			await controller.removeBoard(board.id);
			deletingId = null;
		} catch (value) {
			error = presentError(value);
		} finally {
			busy = false;
		}
	}
</script>

<Dialog.Root {open} requestClose={() => !busy && onClose()}>
	<Dialog.Content
		class="flex max-h-[min(42rem,calc(var(--app-height)-2rem))] flex-col gap-0 overflow-hidden p-0 sm:max-w-xl"
	>
		<Dialog.Header class="shrink-0 border-b border-border px-5 py-4">
			<Dialog.Title>{m.chat_board_dialog_manage_title()}</Dialog.Title>
			<Dialog.Description>{m.chat_board_dialog_manage_description()}</Dialog.Description>
		</Dialog.Header>

		<div class="min-h-0 flex-1 overflow-y-auto px-5 py-4">
			<form
				class="flex items-end gap-2"
				onsubmit={(event) => {
					event.preventDefault();
					void createBoard();
				}}
			>
				<label class="min-w-0 flex-1 text-sm font-medium">
					<span class="mb-1.5 block">{m.chat_board_board_name()}</span>
					<Input
						bind:value={newName}
						maxlength={80}
						disabled={busy || Boolean(pendingCreatedBoardId)}
						autocomplete="off"
					/>
				</label>
				<Button type="submit" disabled={busy || Boolean(pendingCreatedBoardId) || !newName.trim()}
					>{m.chat_board_add()}</Button
				>
			</form>

			{#if error}
				<p
					class="mt-3 rounded-md border border-status-error-border bg-status-error px-3 py-2 text-sm text-status-error-foreground"
					role="alert"
				>
					{error}
				</p>
			{/if}

			<ul class="mt-4 space-y-2" aria-label={m.chat_board_manage_boards()}>
				{#each controller.catalog.boards as board, index (board.id)}
					<li
						class="rounded-lg border bg-card p-2.5 transition-colors"
						class:border-ring={dragOverId === board.id}
						class:border-border={dragOverId !== board.id}
						ondragover={(event) => handleDragOver(event, board.id)}
						ondragleave={() => {
							if (dragOverId === board.id) dragOverId = null;
						}}
						ondrop={(event) => handleDrop(event, board.id)}
						data-chat-board-manager-row={board.id}
					>
						{#if editingId === board.id}
							<form
								class="flex gap-2"
								onsubmit={(event) => {
									event.preventDefault();
									void saveRename(board);
								}}
							>
								<Input
									bind:value={editingName}
									maxlength={80}
									disabled={busy}
									aria-label={m.chat_board_board_name()}
								/>
								<Button size="sm" type="submit" disabled={busy || !editingName.trim()}
									>{m.chat_board_save()}</Button
								>
								<Button size="sm" variant="ghost" onclick={() => (editingId = null)}
									>{m.common_cancel()}</Button
								>
							</form>
						{:else}
							<div class="flex min-w-0 items-center gap-1">
								<button
									type="button"
									draggable={!busy}
									class="grid size-7 shrink-0 cursor-grab place-items-center rounded text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring active:cursor-grabbing disabled:cursor-default disabled:opacity-40"
									aria-label={m.chat_board_drag_board({ name: board.name })}
									disabled={busy}
									ondragstart={(event) => handleDragStart(event, board.id)}
									ondragend={clearDrag}
									data-chat-board-manager-drag={board.id}
								>
									<GripVertical class="size-3.5" aria-hidden="true" />
								</button>
								<button
									type="button"
									class="min-w-0 flex-1 truncate px-1 text-left text-sm font-semibold outline-none focus-visible:ring-2 focus-visible:ring-ring"
									onclick={() => onEditBoard(board)}
								>
									{board.name}
								</button>
								<Button
									size="icon-sm"
									variant="ghost"
									aria-label={m.chat_board_move_up()}
									disabled={busy || index === 0}
									onclick={() => void move(board, -1)}><ArrowUp class="size-3.5" /></Button
								>
								<Button
									size="icon-sm"
									variant="ghost"
									aria-label={m.chat_board_move_down()}
									disabled={busy || index === controller.catalog.boards.length - 1}
									onclick={() => void move(board, 1)}><ArrowDown class="size-3.5" /></Button
								>
								<Button
									size="icon-sm"
									variant="ghost"
									aria-label={m.chat_board_rename()}
									disabled={busy}
									onclick={() => startRename(board)}><Pencil class="size-3.5" /></Button
								>
								<Button
									size="icon-sm"
									variant={deletingId === board.id ? 'destructive' : 'ghost'}
									aria-label={m.chat_board_delete_board_action()}
									disabled={busy}
									onclick={() => void removeBoard(board)}><Trash2 class="size-3.5" /></Button
								>
							</div>
							{#if deletingId === board.id}
								<div
									class="mt-2 flex items-center justify-between gap-3 rounded-md bg-status-error px-2.5 py-2 text-xs text-status-error-foreground"
								>
									<p>{m.chat_board_delete_board_confirm({ name: board.name })}</p>
									<div class="flex shrink-0 gap-1">
										<Button size="sm" variant="ghost" onclick={() => (deletingId = null)}
											>{m.common_cancel()}</Button
										>
										<Button size="sm" variant="destructive" onclick={() => void removeBoard(board)}
											>{m.chat_board_delete()}</Button
										>
									</div>
								</div>
							{/if}
						{/if}
					</li>
				{/each}
			</ul>
		</div>

		<Dialog.Footer class="shrink-0 border-t border-border px-5 py-4">
			<Button variant="outline" disabled={busy} onclick={onClose}>{m.chat_board_done()}</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
