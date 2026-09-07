<script lang="ts">
	import ArrowDown from '@lucide/svelte/icons/arrow-down';
	import ArrowUp from '@lucide/svelte/icons/arrow-up';
	import Copy from '@lucide/svelte/icons/copy';
	import GripVertical from '@lucide/svelte/icons/grip-vertical';
	import Plus from '@lucide/svelte/icons/plus';
	import Trash2 from '@lucide/svelte/icons/trash-2';
	import { untrack } from 'svelte';
	import * as Dialog from '$lib/components/ui/dialog';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import type { ChatBoardController } from '$lib/chat-board/catalog/chat-board-controller.svelte.js';
	import {
		normalizeBoardTagInput,
		normalizeChatBoardCatalog,
		type ChatBoard,
		type ChatBoardColumn,
		type ChatBoardMatchMode,
	} from '$shared/chat-boards';
	import * as m from '$lib/paraglide/messages.js';

	interface ColumnDraft {
		id: string;
		name: string;
		match: ChatBoardMatchMode;
		tagsInput: string;
	}

	function copyBoard(value: ChatBoard): ChatBoard {
		return {
			id: value.id,
			name: value.name,
			columns: value.columns.map((column) => ({
				id: column.id,
				name: column.name,
				match: column.match,
				tags: [...column.tags],
			})),
		};
	}

	let {
		open,
		controller,
		board,
		onClose,
	}: {
		open: boolean;
		controller: ChatBoardController;
		board: ChatBoard;
		onClose: () => void;
	} = $props();

	const initial = untrack(() => ({
		revision: controller.catalog.revision,
		catalog: {
			revision: controller.catalog.revision,
			boards: controller.catalog.boards.map(copyBoard),
		},
		board: copyBoard(board),
	}));
	let baseRevision = $state(initial.revision);
	let baseCatalog = $state(initial.catalog);
	let baseBoardId = $state(initial.board.id);
	let boardName = $state(initial.board.name);
	let columns = $state<ColumnDraft[]>(initial.board.columns.map(toDraft));
	let submitting = $state(false);
	let error = $state<string | null>(null);
	let fieldErrors = $state<Record<string, string>>({});
	let draggedColumnId = $state<string | null>(null);
	let dragOverColumnId = $state<string | null>(null);
	let outdated = $derived(controller.catalog.revision !== baseRevision);

	function toDraft(column: ChatBoardColumn): ColumnDraft {
		return { ...column, tagsInput: column.tags.join(', ') };
	}

	function addColumn(): void {
		columns = [
			...columns,
			{
				id: crypto.randomUUID(),
				name: '',
				match: 'all',
				tagsInput: '',
			},
		];
	}

	function duplicateColumn(index: number): void {
		const source = columns[index];
		if (!source) return;
		columns = [
			...columns.slice(0, index + 1),
			{ ...source, id: crypto.randomUUID(), name: `${source.name} copy` },
			...columns.slice(index + 1),
		];
	}

	function removeColumn(index: number): void {
		columns = columns.filter((_, candidate) => candidate !== index);
	}

	function moveColumn(index: number, offset: -1 | 1): void {
		const target = index + offset;
		if (target < 0 || target >= columns.length) return;
		const next = [...columns];
		[next[index], next[target]] = [next[target], next[index]];
		columns = next;
	}

	function handleDragStart(event: DragEvent, columnId: string): void {
		if (submitting || outdated) {
			event.preventDefault();
			return;
		}
		draggedColumnId = columnId;
		event.dataTransfer?.setData('text/plain', columnId);
		if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
	}

	function handleDragOver(event: DragEvent, columnId: string): void {
		if (!draggedColumnId || draggedColumnId === columnId || submitting || outdated) return;
		event.preventDefault();
		dragOverColumnId = columnId;
		if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
	}

	function handleDrop(event: DragEvent, targetId: string): void {
		event.preventDefault();
		const sourceId = draggedColumnId;
		draggedColumnId = null;
		dragOverColumnId = null;
		if (!sourceId || sourceId === targetId || submitting || outdated) return;
		const sourceIndex = columns.findIndex((column) => column.id === sourceId);
		const targetIndex = columns.findIndex((column) => column.id === targetId);
		if (sourceIndex < 0 || targetIndex < 0) return;
		const next = [...columns];
		const [moved] = next.splice(sourceIndex, 1);
		if (!moved) return;
		next.splice(targetIndex, 0, moved);
		columns = next;
	}

	function clearDrag(): void {
		draggedColumnId = null;
		dragOverColumnId = null;
	}

	function normalizedTags(value: string): string[] {
		return [
			...new Set(
				value
					.split(',')
					.map((tag) => normalizeBoardTagInput(tag.trim()))
					.filter((tag): tag is string => Boolean(tag)),
			),
		].sort((left, right) => left.localeCompare(right));
	}

	function rawTags(value: string): string[] {
		return value
			.split(',')
			.map((tag) => tag.trim())
			.filter(Boolean);
	}

	function identicalRuleFor(index: number): ColumnDraft | null {
		const current = columns[index];
		if (!current) return null;
		const tags = normalizedTags(current.tagsInput).join('\u0000');
		if (!tags) return null;
		return (
			columns.find(
				(candidate, candidateIndex) =>
					candidateIndex !== index &&
					candidate.match === current.match &&
					normalizedTags(candidate.tagsInput).join('\u0000') === tags,
			) ?? null
		);
	}

	function validate(): ChatBoard | null {
		const errors: Record<string, string> = {};
		const name = boardName.trim().normalize('NFC');
		if (!name) errors.boardName = m.chat_board_name_required();
		const seenNames = new Set<string>();
		const normalizedColumns: ChatBoardColumn[] = columns.map((column) => {
			const columnName = column.name.trim().normalize('NFC');
			const key = columnName.normalize('NFKC').toLowerCase();
			if (!columnName) errors[`name:${column.id}`] = m.chat_board_column_name_required();
			else if (seenNames.has(key))
				errors[`name:${column.id}`] = m.chat_board_column_name_duplicate();
			seenNames.add(key);
			const raw = rawTags(column.tagsInput);
			const tags = normalizedTags(column.tagsInput);
			if (tags.length === 0) errors[`tags:${column.id}`] = m.chat_board_column_tags_required();
			else if (raw.length > 32 || raw.some((tag) => !normalizeBoardTagInput(tag))) {
				errors[`tags:${column.id}`] = m.chat_board_column_tags_invalid();
			}
			return { id: column.id, name: columnName, match: column.match, tags };
		});
		fieldErrors = errors;
		if (Object.keys(errors).length > 0) return null;
		const candidate: ChatBoard = { id: baseBoardId, name, columns: normalizedColumns };
		const existing = baseCatalog.boards.map((item) => (item.id === baseBoardId ? candidate : item));
		const catalog = normalizeChatBoardCatalog({ revision: baseRevision, boards: existing });
		if (!catalog) {
			error = m.chat_board_name_duplicate();
			return null;
		}
		return catalog.boards.find((item) => item.id === baseBoardId) ?? null;
	}

	async function save(): Promise<void> {
		if (submitting || outdated) return;
		error = null;
		const normalized = validate();
		if (!normalized) return;
		submitting = true;
		try {
			await controller.updateBoard(normalized, baseRevision);
			onClose();
		} catch (value) {
			if (controller.catalog.revision !== baseRevision) return;
			error = value instanceof Error && value.message ? value.message : m.chat_board_save_failed();
		} finally {
			submitting = false;
		}
	}

	function restartFromLatest(): void {
		const latest = controller.catalog.boards.find((candidate) => candidate.id === baseBoardId);
		if (!latest) {
			onClose();
			return;
		}
		baseRevision = controller.catalog.revision;
		baseCatalog = {
			revision: controller.catalog.revision,
			boards: controller.catalog.boards.map(copyBoard),
		};
		boardName = latest.name;
		columns = latest.columns.map(toDraft);
		fieldErrors = {};
		error = null;
	}
</script>

<Dialog.Root {open} requestClose={() => !submitting && onClose()}>
	<Dialog.Content
		class="flex max-h-[min(48rem,calc(var(--app-height)-1rem))] flex-col gap-0 overflow-hidden p-0 sm:max-w-3xl"
	>
		<Dialog.Header class="shrink-0 border-b border-border px-5 py-4 sm:px-6">
			<Dialog.Title>{m.chat_board_edit_columns()}</Dialog.Title>
			<Dialog.Description>{m.chat_board_source_removal_note()}</Dialog.Description>
		</Dialog.Header>

		<div class="min-h-0 flex-1 overflow-y-auto px-5 py-4 sm:px-6">
			{#if outdated}
				<div
					class="mb-4 rounded-lg border border-status-warning-border bg-status-warning/10 p-3 text-sm text-status-warning-muted-foreground"
					role="alert"
				>
					<p>{m.chat_board_outdated()}</p>
					<Button class="mt-2" size="sm" variant="outline" onclick={restartFromLatest}
						>{m.chat_board_start_latest()}</Button
					>
				</div>
			{/if}

			<label class="block text-sm font-medium">
				<span class="mb-1.5 block">{m.chat_board_board_name()}</span>
				<Input
					bind:value={boardName}
					maxlength={80}
					disabled={submitting || outdated}
					aria-invalid={Boolean(fieldErrors.boardName)}
				/>
				{#if fieldErrors.boardName}<span class="mt-1 block text-xs text-destructive"
						>{fieldErrors.boardName}</span
					>{/if}
			</label>

			<div class="mt-5 space-y-3">
				{#each columns as column, index (column.id)}
					<fieldset
						class="rounded-xl border bg-muted/25 p-3 transition-colors"
						class:border-ring={dragOverColumnId === column.id}
						class:border-border={dragOverColumnId !== column.id}
						disabled={submitting || outdated}
						ondragover={(event) => handleDragOver(event, column.id)}
						ondragleave={() => {
							if (dragOverColumnId === column.id) dragOverColumnId = null;
						}}
						ondrop={(event) => handleDrop(event, column.id)}
						data-chat-board-column-editor={column.id}
					>
						<legend class="sr-only">{m.chat_board_column_name()}</legend>
						<div class="flex items-start gap-2">
							<button
								type="button"
								draggable={!submitting && !outdated}
								class="mt-6 grid size-8 shrink-0 cursor-grab place-items-center rounded-md text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring active:cursor-grabbing disabled:cursor-default disabled:opacity-40"
								aria-label={m.chat_board_drag_column({
									name: column.name || m.chat_board_column_name(),
								})}
								disabled={submitting || outdated}
								ondragstart={(event) => handleDragStart(event, column.id)}
								ondragend={clearDrag}
								data-chat-board-column-drag={column.id}
							>
								<GripVertical class="size-4" aria-hidden="true" />
							</button>
							<div class="grid min-w-0 flex-1 gap-3 sm:grid-cols-[minmax(0,1fr)_10rem]">
								<label class="text-sm font-medium">
									<span class="mb-1.5 block">{m.chat_board_column_name()}</span>
									<Input
										bind:value={column.name}
										maxlength={80}
										aria-invalid={Boolean(fieldErrors[`name:${column.id}`])}
									/>
									{#if fieldErrors[`name:${column.id}`]}<span
											class="mt-1 block text-xs text-destructive"
											>{fieldErrors[`name:${column.id}`]}</span
										>{/if}
								</label>
								<label class="text-sm font-medium">
									<span class="mb-1.5 block"
										>{column.match === 'all'
											? m.chat_board_match_all()
											: m.chat_board_match_any()}</span
									>
									<select
										class="h-9 w-full rounded-md border border-input bg-background px-3 text-base outline-none focus-visible:ring-2 focus-visible:ring-ring sm:pointer-fine:text-sm"
										bind:value={column.match}
									>
										<option value="all">{m.chat_board_match_all()}</option>
										<option value="any">{m.chat_board_match_any()}</option>
									</select>
								</label>
							</div>
							<div class="flex shrink-0 gap-0.5 pt-6">
								<Button
									size="icon-sm"
									variant="ghost"
									aria-label={m.chat_board_move_up()}
									disabled={index === 0}
									onclick={() => moveColumn(index, -1)}><ArrowUp class="size-3.5" /></Button
								>
								<Button
									size="icon-sm"
									variant="ghost"
									aria-label={m.chat_board_move_down()}
									disabled={index === columns.length - 1}
									onclick={() => moveColumn(index, 1)}><ArrowDown class="size-3.5" /></Button
								>
								<Button
									size="icon-sm"
									variant="ghost"
									aria-label={m.chat_board_duplicate_column()}
									onclick={() => duplicateColumn(index)}><Copy class="size-3.5" /></Button
								>
								<Button
									size="icon-sm"
									variant="ghost"
									aria-label={m.chat_board_delete()}
									onclick={() => removeColumn(index)}><Trash2 class="size-3.5" /></Button
								>
							</div>
						</div>
						<label class="mt-3 block text-sm font-medium">
							<span class="mb-1.5 block">{m.chat_board_column_tags()}</span>
							<Input
								bind:value={column.tagsInput}
								aria-invalid={Boolean(fieldErrors[`tags:${column.id}`])}
								placeholder="ready, review"
							/>
							<span class="mt-1 block text-xs text-muted-foreground"
								>{m.chat_board_column_tags_hint()}</span
							>
							{#if fieldErrors[`tags:${column.id}`]}<span
									class="mt-1 block text-xs text-destructive"
									>{fieldErrors[`tags:${column.id}`]}</span
								>{/if}
						</label>
						{#if normalizedTags(column.tagsInput).length > 0}
							<p class="mt-2 text-xs text-muted-foreground">
								{normalizedTags(column.tagsInput).join(' · ')}
							</p>
						{/if}
						{#if identicalRuleFor(index)}
							<p class="mt-2 text-xs text-status-warning-muted-foreground">
								{m.chat_board_column_rule_duplicate({
									column: identicalRuleFor(index)?.name || m.chat_board_column_name(),
								})}
							</p>
						{/if}
					</fieldset>
				{/each}
			</div>

			<Button
				class="mt-3 gap-2"
				variant="outline"
				onclick={addColumn}
				disabled={submitting || outdated}
			>
				<Plus class="size-4" />
				{m.chat_board_add_column()}
			</Button>
			<p class="mt-3 text-xs text-muted-foreground">{m.chat_board_columns_delete_note()}</p>
			{#if error}<p
					class="mt-3 rounded-md border border-status-error-border bg-status-error px-3 py-2 text-sm text-status-error-foreground"
					role="alert"
				>
					{error}
				</p>{/if}
		</div>

		<Dialog.Footer class="shrink-0 border-t border-border px-5 py-4 sm:px-6">
			<Button variant="outline" disabled={submitting} onclick={onClose}>{m.common_cancel()}</Button>
			<Button disabled={submitting || outdated} onclick={() => void save()}
				>{m.chat_board_save()}</Button
			>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
