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
	import { copyChatBoard } from '$lib/chat-board/catalog/chat-board-copy.js';
	import type { ChatBoardController } from '$lib/chat-board/catalog/chat-board-controller.svelte.js';
	import {
		CHAT_BOARD_COLUMN_MAX_COUNT,
		normalizeBoardTagInput,
		normalizeChatBoardCatalog,
		type ChatBoard,
		type ChatBoardColumn,
		type ChatBoardMatchMode,
	} from '$shared/chat-boards';
	import { BoardReorderState } from './board-reorder-state.svelte.js';
	import * as m from '$lib/paraglide/messages.js';

	interface ColumnDraft {
		id: string;
		name: string;
		match: ChatBoardMatchMode;
		tagsInput: string;
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
			boards: controller.catalog.boards.map(copyChatBoard),
		},
		board: copyChatBoard(board),
	}));
	let baseRevision = $state(initial.revision);
	let baseCatalog = $state(initial.catalog);
	let baseBoardId = $state(initial.board.id);
	let boardName = $state(initial.board.name);
	let columns = $state<ColumnDraft[]>(initial.board.columns.map(toDraft));
	let submitting = $state(false);
	let error = $state<string | null>(null);
	let fieldErrors = $state<Record<string, string>>({});
	const reorder = new BoardReorderState(() => columns, () => submitting || outdated, (items) => { columns = items; });
	let outdated = $derived(controller.catalog.revision !== baseRevision);
	let columnLimitReached = $derived(columns.length >= CHAT_BOARD_COLUMN_MAX_COUNT);

	function toDraft(column: ChatBoardColumn): ColumnDraft {
		return { ...column, tagsInput: column.tags.join(', ') };
	}

	function addColumn(): void {
		if (columnLimitReached) {
			error = m.chat_board_column_limit({ count: CHAT_BOARD_COLUMN_MAX_COUNT });
			return;
		}
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
		if (columnLimitReached) {
			error = m.chat_board_column_limit({ count: CHAT_BOARD_COLUMN_MAX_COUNT });
			return;
		}
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

	function parseTags(value: string) {
		const raw = value.split(',').map((tag) => tag.trim()).filter(Boolean);
		const normalized = raw.map(normalizeBoardTagInput);
		const tags = [...new Set(normalized.filter((tag): tag is string => Boolean(tag)))]
			.sort((left, right) => left.localeCompare(right));
		return { tags, invalid: raw.length > 32 || normalized.some((tag) => !tag) };
	}

	const columnRules = $derived.by(() => {
		const groups = new Map<string, string[]>();
		const byId = new Map<string, { tags: string[]; invalid: boolean; matches?: string[] }>();
		for (const column of columns) {
			const rule = parseTags(column.tagsInput);
			if (rule.tags.length === 0) {
				byId.set(column.id, rule);
				continue;
			}
			const key = `${column.match}\0${rule.tags.join('\0')}`;
			const matches = groups.get(key) ?? [];
			if (matches.length === 0) groups.set(key, matches);
			matches.push(column.id);
			byId.set(column.id, { ...rule, matches });
		}
		return byId;
	});
	const columnsById = $derived(new Map(columns.map((column) => [column.id, column])));

	function validate(): ChatBoard | null {
		if (columns.length > CHAT_BOARD_COLUMN_MAX_COUNT) {
			error = m.chat_board_column_limit({ count: CHAT_BOARD_COLUMN_MAX_COUNT });
			return null;
		}
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
			const { tags, invalid } = columnRules.get(column.id)!;
			if (tags.length === 0) errors[`tags:${column.id}`] = m.chat_board_column_tags_required();
			else if (invalid) {
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
			boards: controller.catalog.boards.map(copyChatBoard),
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
					{@const rule = columnRules.get(column.id)!}
					{@const matches = rule.matches}
					{@const duplicateId = matches?.[matches[0] === column.id ? 1 : 0]}
					<fieldset
						class="rounded-xl border bg-muted/25 p-3 transition-colors"
						class:border-ring={reorder.overId === column.id}
						class:border-border={reorder.overId !== column.id}
						disabled={submitting || outdated}
						ondragover={(event) => reorder.over(event, column.id)}
						ondragleave={() => reorder.leave(column.id)}
						ondrop={(event) => reorder.drop(event, column.id)}
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
								ondragstart={(event) => reorder.start(event, column.id)}
								ondragend={() => reorder.clear()}
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
									disabled={columnLimitReached}
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
						{#if rule.tags.length > 0}
							<p class="mt-2 text-xs text-muted-foreground">
								{rule.tags.join(' · ')}
							</p>
						{/if}
						{#if duplicateId}
							<p class="mt-2 text-xs text-status-warning-muted-foreground">
								{m.chat_board_column_rule_duplicate({
									column: columnsById.get(duplicateId)?.name || m.chat_board_column_name(),
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
				disabled={submitting || outdated || columnLimitReached}
			>
				<Plus class="size-4" />
				{m.chat_board_add_column()}
			</Button>
			{#if columnLimitReached}
				<p class="mt-2 text-xs text-muted-foreground" role="status">
					{m.chat_board_column_limit({ count: CHAT_BOARD_COLUMN_MAX_COUNT })}
				</p>
			{/if}
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
