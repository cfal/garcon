<script lang="ts">
	import ArrowRight from '@lucide/svelte/icons/arrow-right';
	import CircleAlert from '@lucide/svelte/icons/circle-alert';
	import { untrack } from 'svelte';
	import * as Dialog from '$lib/components/ui/dialog';
	import { Button } from '$lib/components/ui/button';
	import ColoredTag from '$lib/components/shared/ColoredTag.svelte';
	import { copyChatBoard } from '$lib/chat-board/catalog/chat-board-copy.js';
	import type { ChatBoardController } from '$lib/chat-board/catalog/chat-board-controller.svelte.js';
	import type { ChatBoardOccurrence } from '$lib/chat-board/projection/chat-board-projection.js';
	import {
		initialTargetTags,
		projectChatBoardTransition,
		type ChatBoardTransitionDestination,
	} from '$lib/chat-board/transition/chat-board-transition.js';
	import {
		isChatTagRefreshRequired,
		type ChatSessionsPort,
	} from '$lib/chat/sessions/chat-sessions-contract.js';
	import { chatMatchesBoardColumn, type ChatBoard } from '$shared/chat-boards';
	import { ApiError } from '$lib/api/client.js';
	import { ChatTagMutationBlockedError } from '$lib/chat/sessions/chat-tag-mutation-result.js';
	import type { ChatTagTransitionTarget } from '$shared/chat-tag-mutations';
	import * as m from '$lib/paraglide/messages.js';

	const NONE_TARGET_VALUE = 'none';

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
		onApplied: (chatId: string, target: ChatTagTransitionTarget) => void;
	} = $props();

	const initial = untrack(() => ({
		board: copyChatBoard(board),
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
	let targetValue = $state(initialDestinationId);
	let target = $derived.by((): ChatBoardTransitionDestination | null => {
		if (targetValue === NONE_TARGET_VALUE) return { kind: 'none' };
		const column = destinations.find((candidate) => candidate.id === targetValue);
		return column ? { kind: 'column', column } : null;
	});
	let selectedTargetTags = $state<string[]>(
		initialDestination ? [...initialTargetTags(initial.tags, initialDestination)] : [],
	);
	let submitting = $state(false);
	let reconciling = $state(false);
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
	let reconciliationKind = $derived(sessions.tagReconciliationKind(occurrence.chat.id));
	let refreshRequired = $derived(isChatTagRefreshRequired(reconciliationKind));
	let reconciliationProgressLabel = $derived(
		refreshRequired ? m.chat_board_refreshing_tags() : m.chat_board_confirming_tags(),
	);
	let reconciliationRetryLabel = $derived(
		refreshRequired ? m.chat_tags_retry_refresh() : m.chat_tags_retry_confirmation(),
	);
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
			(target.kind === 'none' ||
				target.column.match === 'all' ||
				preview.appliedTargetTags.length > 0) &&
			reconciliationKind === null,
		),
	);
	let title = $derived(occurrence.chat.title || m.sidebar_chats_unnamed());

	function chooseTarget(value: string): void {
		targetValue = value;
		const next = destinations.find((column) => column.id === value);
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
			latestDestinations.find((column) => column.id === targetValue) ??
			latestDestinations[0] ??
			null;
		baseBoard = copyChatBoard(latestBoard);
		baseRevision = controller.catalog.revision;
		baseTags = [...latestChat.tags];
		const reviewingNone = targetValue === NONE_TARGET_VALUE;
		targetValue = reviewingNone ? NONE_TARGET_VALUE : (latestTarget?.id ?? '');
		selectedTargetTags =
			!reviewingNone && latestTarget ? [...initialTargetTags(baseTags, latestTarget)] : [];
		forcedOutdated = false;
		submitError = null;
	}

	function columnNames(ids: readonly string[]): string {
		return ids
			.map((id) => baseBoard.columns.find((column) => column.id === id)?.name)
			.filter((name): name is string => Boolean(name))
			.join(', ');
	}

	function toRequestTarget(
		target: ChatBoardTransitionDestination,
		appliedTargetTags: readonly string[],
	): ChatTagTransitionTarget {
		if (target.kind === 'none') return { kind: 'none' };
		if (target.column.match === 'any') {
			return {
				kind: 'column',
				columnId: target.column.id,
				selectedTargetTags: appliedTargetTags,
			};
		}
		return { kind: 'column', columnId: target.column.id };
	}

	async function confirm(): Promise<void> {
		if (!canSubmit || !source || !target || !preview || submitting) return;
		const requestedTarget = toRequestTarget(target, preview.appliedTargetTags);
		submitting = true;
		submitError = null;
		try {
			await sessions.transitionChatTags({
				chatId: occurrence.chat.id,
				boardId: baseBoard.id,
				sourceColumnId: source.id,
				target: requestedTarget,
				expectedCatalogRevision: baseRevision,
				expectedTags: baseTags,
			});
			onApplied(occurrence.chat.id, requestedTarget);
		} catch (value) {
			const currentReconciliation = sessions.tagReconciliationKind(occurrence.chat.id);
			if (value instanceof ChatTagMutationBlockedError) {
				forcedOutdated = true;
				submitError = m.chat_tags_mutation_blocked();
			} else if (
				(value instanceof ApiError && value.errorCode === 'CHAT_TAG_SAVE_UNKNOWN') ||
				currentReconciliation === 'durability'
			) {
				forcedOutdated = true;
				submitError = m.chat_tags_confirmation_unknown();
			} else if (value instanceof ApiError && value.status === 409) {
				forcedOutdated = true;
				submitError = m.chat_board_transition_outdated();
				await controller.refresh(false);
				await sessions.quietRefreshChats();
			} else if (isChatTagRefreshRequired(currentReconciliation)) {
				forcedOutdated = true;
				submitError =
					currentReconciliation === 'committed-refresh'
						? m.chat_tags_refresh_required()
						: m.chat_tags_conflict_refresh_required();
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

	async function retryReconciliation(): Promise<void> {
		if (!reconciliationKind || reconciling) return;
		const requestedKind = reconciliationKind;
		reconciling = true;
		submitError = null;
		try {
			await sessions.retryTagReconciliation(occurrence.chat.id);
			submitError = isChatTagRefreshRequired(requestedKind)
				? m.chat_board_transition_outdated()
				: m.chat_board_transition_unknown();
		} catch {
			submitError = isChatTagRefreshRequired(requestedKind)
				? m.chat_tags_refresh_failed()
				: m.chat_tags_confirmation_failed();
		} finally {
			reconciling = false;
		}
	}

	function transitionErrorMessage(): string {
		if (currentChat?.isArchived) return m.chat_board_transition_missing();
		if (outdated) return m.chat_board_transition_outdated();
		if (!sourceMatches) return m.chat_board_transition_source_missing();
		return m.chat_board_transition_no_changes();
	}

	function preventAutomaticFocusRestore(event: Event): void {
		event.preventDefault();
	}
</script>

<Dialog.Root {open} requestClose={() => !submitting && onClose()}>
	<Dialog.Content
		class="flex max-h-[min(46rem,calc(var(--app-height)-1rem))] flex-col gap-0 overflow-hidden p-0 sm:max-w-2xl"
		onCloseAutoFocus={preventAutomaticFocusRestore}
	>
		<Dialog.Header class="shrink-0 border-b border-border px-5 py-4 sm:px-6">
			<Dialog.Title>{m.chat_board_transition_title()}</Dialog.Title>
			<Dialog.Description>{m.chat_board_transition_description()}</Dialog.Description>
		</Dialog.Header>

		<div class="min-h-0 flex-1 overflow-y-auto px-5 py-4 sm:px-6">
			<h3 class="truncate text-base font-semibold">“{title}”</h3>
			<div class="mt-2 flex items-center gap-2 text-sm text-muted-foreground">
				<span>{source?.name ?? m.chat_board_transition_none()}</span>
				<ArrowRight class="size-4" aria-hidden="true" />
				<label class="min-w-0 flex-1">
					<span class="sr-only">{m.chat_board_transition_choose_target()}</span>
					<select
						class="h-9 w-full rounded-md border border-input bg-background px-3 text-base font-medium text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring sm:pointer-fine:text-sm"
						value={targetValue}
						disabled={submitting}
						onchange={(event) => chooseTarget(event.currentTarget.value)}
					>
						<option value="" disabled>{m.chat_board_transition_choose_action()}</option>
						{#if destinations.length > 0}
							<optgroup label={m.chat_board_transition_columns()}>
								{#each destinations as column (column.id)}
									<option value={column.id}>{column.name}</option>
								{/each}
							</optgroup>
						{/if}
						<optgroup label={m.chat_board_transition_actions()}>
							<option value={NONE_TARGET_VALUE}>{m.chat_board_transition_none()}</option>
						</optgroup>
					</select>
				</label>
			</div>

			{#if !source || !currentChat}
				<p
					class="mt-4 rounded-lg border border-status-warning-border bg-status-warning/10 p-3 text-sm text-status-warning-muted-foreground"
					role="alert"
				>
					{m.chat_board_transition_missing()}
				</p>
			{:else if !target}
				<p class="mt-4 rounded-lg border border-border bg-muted/30 p-3 text-sm text-muted-foreground">
					{m.chat_board_transition_choose_action()}
				</p>
			{:else}
				<div class="mt-5 grid gap-4">
					<section>
						<h4 class="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
							{m.chat_board_transition_current_tags()}
						</h4>
						<div class="mt-2 flex flex-wrap gap-1.5">
							{#if baseTags.length > 0}
								{#each baseTags as tag (tag)}
									<ColoredTag label={tag} autoColor />
								{/each}
							{:else}
								<span class="text-sm text-muted-foreground">{m.chat_board_transition_none()}</span>
							{/if}
						</div>
					</section>

					{#if target.kind === 'column' && target.column.match === 'any'}
						<fieldset>
							<legend class="text-xs font-semibold uppercase tracking-wide text-muted-foreground"
								>{m.chat_board_transition_apply_tags()}</legend
							>
							<div class="mt-2 flex flex-wrap gap-2">
								{#each target.column.tags as tag (tag)}
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
									{preview.removedTags.join(', ') || m.chat_board_transition_none()}
								</p>
							</section>
							<section class="rounded-lg border border-status-success-border bg-status-success p-3">
								<h4
									class="text-xs font-semibold uppercase tracking-wide text-status-success-foreground"
								>
									{m.chat_board_transition_add()}
								</h4>
								<p class="mt-1.5 text-sm text-status-success-foreground">
									{preview.addedTags.join(', ') || m.chat_board_transition_none()}
								</p>
							</section>
						</div>

						<section>
							<h4 class="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
								{m.chat_board_transition_result()}
							</h4>
							<div class="mt-2 flex flex-wrap gap-1.5">
								{#if preview.resultingTags.length > 0}
									{#each preview.resultingTags as tag (tag)}
										<ColoredTag label={tag} autoColor />
									{/each}
								{:else}
									<span class="text-sm text-muted-foreground">{m.chat_board_transition_none()}</span
									>
								{/if}
							</div>
						</section>

						<section class="rounded-lg border border-border bg-muted/30 p-3">
							<h4 class="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
								{m.chat_board_transition_membership()}
							</h4>
							<p class="mt-1 text-sm font-medium">
								{columnNames(preview.matchingColumnIds) || m.chat_board_transition_none()}
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
							{#if target.kind === 'none'}
								<p class="mt-1">{m.chat_board_transition_none_explanation()}</p>
							{/if}
						</div>
					</div>
					{#if outdated || submitError || currentChat.isArchived || !sourceMatches || preview?.isNoop}
						<p
							class="rounded-lg border border-status-error-border bg-status-error px-3 py-2 text-sm text-status-error-foreground"
							role="alert"
						>
							{submitError ?? transitionErrorMessage()}
						</p>
					{/if}
					{#if reconciliationKind}
						<Button
							variant="outline"
							disabled={submitting || reconciling}
							onclick={() => void retryReconciliation()}
						>
							{reconciling ? reconciliationProgressLabel : reconciliationRetryLabel}
						</Button>
					{:else if outdated}
						<Button variant="outline" disabled={submitting || reconciling} onclick={reviewLatest}>
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
