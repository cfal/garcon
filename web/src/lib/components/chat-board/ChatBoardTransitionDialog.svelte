<script lang="ts">
	import ArrowRight from '@lucide/svelte/icons/arrow-right';
	import CircleAlert from '@lucide/svelte/icons/circle-alert';
	import { untrack } from 'svelte';
	import * as Dialog from '$lib/components/ui/dialog';
	import { Button } from '$lib/components/ui/button';
	import ColoredTag from '$lib/components/shared/ColoredTag.svelte';
	import type { ChatBoardController } from '$lib/chat-board/catalog/chat-board-controller.svelte.js';
	import type { ChatBoardOccurrence } from '$lib/chat-board/projection/chat-board-projection.js';
	import {
		initialTargetTags,
		projectChatBoardTransition,
	} from '$lib/chat-board/transition/chat-board-transition.js';
	import type { ChatSessionsPort } from '$lib/chat/sessions/chat-sessions-contract.js';
	import { chatMatchesBoardColumn, type ChatBoard } from '$shared/chat-boards';
	import { ApiError } from '$lib/api/client.js';
	import * as m from '$lib/paraglide/messages.js';

	let {
		open,
		controller,
		sessions,
		board,
		occurrence,
		initialTargetColumnId,
		onClose,
		onApplied,
	}: {
		open: boolean;
		controller: ChatBoardController;
		sessions: ChatSessionsPort;
		board: ChatBoard;
		occurrence: ChatBoardOccurrence;
		initialTargetColumnId?: string | null;
		onClose: () => void;
		onApplied: (chatId: string, targetColumnId: string) => void;
	} = $props();

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

	const initial = untrack(() => ({
		board: copyBoard(board),
		revision: controller.catalog.revision,
		tags: [...occurrence.chat.tags],
	}));
	let baseBoard = $state<ChatBoard>(initial.board);
	let baseRevision = $state(initial.revision);
	let baseTags = $state<string[]>(initial.tags);
	let source = $derived(
		baseBoard.columns.find((column) => column.id === occurrence.columnId) ?? null,
	);
	let destinations = $derived(
		baseBoard.columns.filter((column) => column.id !== occurrence.columnId),
	);
	const requestedTargetId = untrack(() => initialTargetColumnId);
	const initialDestinations = initial.board.columns.filter(
		(column) => column.id !== occurrence.columnId,
	);
	const initialDestinationId = initialDestinations.some((column) => column.id === requestedTargetId)
		? (requestedTargetId as string)
		: (initialDestinations[0]?.id ?? '');
	const initialDestination =
		initialDestinations.find((column) => column.id === initialDestinationId) ?? null;
	let targetColumnId = $state(initialDestinationId);
	let target = $derived(destinations.find((column) => column.id === targetColumnId) ?? null);
	let selectedTargetTags = $state<string[]>(
		initialDestination ? [...initialTargetTags(initial.tags, initialDestination)] : [],
	);
	let submitting = $state(false);
	let submitError = $state<string | null>(null);
	let forcedOutdated = $state(false);
	let currentChat = $derived(sessions.byId[occurrence.chat.id] ?? null);
	let tagsChanged = $derived(
		Boolean(currentChat) && JSON.stringify(currentChat?.tags) !== JSON.stringify(baseTags),
	);
	let outdated = $derived(
		forcedOutdated || controller.catalog.revision !== baseRevision || tagsChanged,
	);
	let preview = $derived(
		source && target
			? projectChatBoardTransition({
					board: baseBoard,
					source,
					target,
					currentTags: baseTags,
					selectedTargetTags,
				})
			: null,
	);
	let sourceMatches = $derived(Boolean(source && chatMatchesBoardColumn(baseTags, source)));
	let canSubmit = $derived(
		Boolean(
			preview &&
			source &&
			target &&
			currentChat &&
			!currentChat.isArchived &&
			sourceMatches &&
			!outdated &&
			!preview.isNoop &&
			(target.match === 'all' || preview.appliedTargetTags.length > 0) &&
			!sessions.tagRecoveryRequiredChatIds.has(occurrence.chat.id),
		),
	);
	let title = $derived(occurrence.chat.title || m.sidebar_chats_unnamed());

	function chooseTarget(columnId: string): void {
		targetColumnId = columnId;
		const next = destinations.find((column) => column.id === columnId);
		selectedTargetTags = next ? [...initialTargetTags(baseTags, next)] : [];
		submitError = null;
	}

	function toggleTargetTag(tag: string, checked: boolean): void {
		selectedTargetTags = checked
			? [...selectedTargetTags, tag]
			: selectedTargetTags.filter((candidate) => candidate !== tag);
	}

	function reviewLatest(): void {
		const latestBoard = controller.catalog.boards.find(
			(candidate) => candidate.id === baseBoard.id,
		);
		const latestChat = sessions.byId[occurrence.chat.id];
		if (!latestBoard || !latestChat) {
			forcedOutdated = true;
			submitError = m.chat_board_transition_missing();
			return;
		}
		const latestDestinations = latestBoard.columns.filter(
			(column) => column.id !== occurrence.columnId,
		);
		const latestTarget =
			latestDestinations.find((column) => column.id === targetColumnId) ??
			latestDestinations[0] ??
			null;
		baseBoard = copyBoard(latestBoard);
		baseRevision = controller.catalog.revision;
		baseTags = [...latestChat.tags];
		targetColumnId = latestTarget?.id ?? '';
		selectedTargetTags = latestTarget ? [...initialTargetTags(baseTags, latestTarget)] : [];
		forcedOutdated = false;
		submitError = null;
	}

	function columnNames(ids: readonly string[]): string {
		return ids
			.map((id) => baseBoard.columns.find((column) => column.id === id)?.name)
			.filter((name): name is string => Boolean(name))
			.join(', ');
	}

	async function confirm(): Promise<void> {
		if (!canSubmit || !source || !target || !preview || submitting) return;
		submitting = true;
		submitError = null;
		try {
			await sessions.transitionChatTags({
				chatId: occurrence.chat.id,
				boardId: baseBoard.id,
				sourceColumnId: source.id,
				targetColumnId: target.id,
				expectedCatalogRevision: baseRevision,
				expectedTags: baseTags,
				...(target.match === 'any' ? { selectedTargetTags: preview.appliedTargetTags } : {}),
			});
			onApplied(occurrence.chat.id, target.id);
		} catch (value) {
			if (value instanceof ApiError && value.errorCode === 'CHAT_TAG_SAVE_UNKNOWN') {
				forcedOutdated = true;
				submitError = m.chat_board_transition_unknown();
				try {
					await sessions.recoverChatTags(occurrence.chat.id);
				} catch {
					// The shared recovery fence keeps every tag writer disabled.
				}
			} else if (value instanceof ApiError && value.status === 409) {
				forcedOutdated = true;
				submitError = m.chat_board_transition_outdated();
				await controller.refresh(false);
				await sessions.quietRefreshChats();
			} else {
				submitError =
					value instanceof Error && value.message
						? value.message
						: m.chat_board_transition_failed();
			}
		} finally {
			submitting = false;
		}
	}

	function tagGroup(tags: readonly string[]): readonly string[] {
		return tags.length > 0 ? tags : ['—'];
	}
</script>

<Dialog.Root {open} requestClose={() => !submitting && onClose()}>
	<Dialog.Content
		class="flex max-h-[min(46rem,calc(var(--app-height)-1rem))] flex-col gap-0 overflow-hidden p-0 sm:max-w-2xl"
	>
		<Dialog.Header class="shrink-0 border-b border-border px-5 py-4 sm:px-6">
			<Dialog.Title>{m.chat_board_transition_title()}</Dialog.Title>
			<Dialog.Description>{m.chat_board_transition_description()}</Dialog.Description>
		</Dialog.Header>

		<div class="min-h-0 flex-1 overflow-y-auto px-5 py-4 sm:px-6">
			<h3 class="truncate text-base font-semibold">“{title}”</h3>
			<div class="mt-2 flex items-center gap-2 text-sm text-muted-foreground">
				<span>{source?.name ?? '—'}</span>
				<ArrowRight class="size-4" aria-hidden="true" />
				<label class="min-w-0 flex-1">
					<span class="sr-only">{m.chat_board_transition_choose_target()}</span>
					<select
						class="h-9 w-full rounded-md border border-input bg-background px-3 text-base font-medium text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring sm:pointer-fine:text-sm"
						value={targetColumnId}
						disabled={submitting}
						onchange={(event) => chooseTarget(event.currentTarget.value)}
					>
						{#each destinations as column (column.id)}
							<option value={column.id}>{column.name}</option>
						{/each}
					</select>
				</label>
			</div>

			{#if !source || !target || !currentChat}
				<p
					class="mt-4 rounded-lg border border-status-warning-border bg-status-warning/10 p-3 text-sm text-status-warning-muted-foreground"
					role="alert"
				>
					{m.chat_board_transition_missing()}
				</p>
			{:else}
				<div class="mt-5 grid gap-4">
					<section>
						<h4 class="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
							{m.chat_board_transition_current_tags()}
						</h4>
						<div class="mt-2 flex flex-wrap gap-1.5">
							{#each tagGroup(baseTags) as tag (tag)}
								{#if tag === '—'}<span class="text-sm text-muted-foreground">—</span
									>{:else}<ColoredTag label={tag} autoColor />{/if}
							{/each}
						</div>
					</section>

					{#if target.match === 'any'}
						<fieldset>
							<legend class="text-xs font-semibold uppercase tracking-wide text-muted-foreground"
								>{m.chat_board_transition_apply_tags()}</legend
							>
							<div class="mt-2 flex flex-wrap gap-2">
								{#each target.tags as tag (tag)}
									<label
										class="inline-flex min-h-9 items-center gap-2 rounded-lg border border-border bg-background px-2.5 text-sm hover:bg-accent"
									>
										<input
											type="checkbox"
											checked={selectedTargetTags.includes(tag)}
											disabled={submitting}
											onchange={(event) => toggleTargetTag(tag, event.currentTarget.checked)}
										/>
										<span>{tag}</span>
									</label>
								{/each}
							</div>
						</fieldset>
					{/if}

					{#if preview}
						<div class="grid gap-3 sm:grid-cols-2">
							<section
								class="rounded-lg border border-status-error-border/70 bg-status-error/50 p-3"
							>
								<h4
									class="text-xs font-semibold uppercase tracking-wide text-status-error-foreground"
								>
									{m.chat_board_transition_remove()}
								</h4>
								<p class="mt-1.5 text-sm text-status-error-foreground">
									{tagGroup(preview.removedTags).join(', ')}
								</p>
							</section>
							<section class="rounded-lg border border-status-success-border bg-status-success p-3">
								<h4
									class="text-xs font-semibold uppercase tracking-wide text-status-success-foreground"
								>
									{m.chat_board_transition_add()}
								</h4>
								<p class="mt-1.5 text-sm text-status-success-foreground">
									{tagGroup(preview.addedTags).join(', ')}
								</p>
							</section>
						</div>

						<section>
							<h4 class="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
								{m.chat_board_transition_result()}
							</h4>
							<div class="mt-2 flex flex-wrap gap-1.5">
								{#each tagGroup(preview.resultingTags) as tag (tag)}
									{#if tag === '—'}<span class="text-sm text-muted-foreground">—</span
										>{:else}<ColoredTag label={tag} autoColor />{/if}
								{/each}
							</div>
						</section>

						<section class="rounded-lg border border-border bg-muted/30 p-3">
							<h4 class="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
								{m.chat_board_transition_membership()}
							</h4>
							<p class="mt-1 text-sm font-medium">
								{columnNames(preview.matchingColumnIds) || '—'}
							</p>
							{#if preview.sourceStillMatches}<p
									class="mt-2 text-xs text-status-warning-muted-foreground"
								>
									{m.chat_board_transition_source_remains({ column: source.name })}
								</p>{/if}
						</section>
					{/if}

					<div
						class="flex gap-2 rounded-lg border border-status-warning-border/70 bg-status-warning/10 p-3 text-sm text-status-warning-muted-foreground"
					>
						<CircleAlert class="mt-0.5 size-4 shrink-0" aria-hidden="true" />
						<div>
							<p>{m.chat_board_transition_global_warning()}</p>
							<p class="mt-1">{m.chat_board_source_removal_note()}</p>
						</div>
					</div>
					{#if outdated || submitError || currentChat.isArchived || !sourceMatches || preview?.isNoop}
						<p
							class="rounded-lg border border-status-error-border bg-status-error px-3 py-2 text-sm text-status-error-foreground"
							role="alert"
						>
							{submitError ??
								(currentChat.isArchived
									? m.chat_board_transition_missing()
									: outdated
										? m.chat_board_transition_outdated()
										: !sourceMatches
											? m.chat_board_transition_source_missing()
											: m.chat_board_transition_no_changes())}
						</p>
					{/if}
					{#if outdated}
						<Button
							variant="outline"
							disabled={submitting || sessions.tagRecoveryRequiredChatIds.has(occurrence.chat.id)}
							onclick={reviewLatest}
						>
							{m.chat_board_review_latest()}
						</Button>
					{/if}
				</div>
			{/if}
		</div>

		<Dialog.Footer class="shrink-0 border-t border-border px-5 py-4 sm:px-6">
			<Button variant="outline" disabled={submitting} onclick={onClose}>{m.common_cancel()}</Button>
			<Button disabled={!canSubmit || submitting} onclick={() => void confirm()}
				>{m.chat_board_transition_apply()}</Button
			>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
