<script lang="ts">
	import * as Dialog from '$lib/components/ui/dialog';
	import { Button } from '$lib/components/ui/button';
	import Input from '$lib/components/ui/input/input.svelte';
	import * as m from '$lib/paraglide/messages.js';
	import X from '@lucide/svelte/icons/x';
	import ColoredTag from '../shared/ColoredTag.svelte';
	import { getTagColorClasses } from '$lib/utils/tag-colors';
	import { normalizeTags } from '$shared/tags';
	import {
		isChatTagRefreshRequired,
		type ChatTagReconciliationKind,
	} from '$lib/chat/sessions/chat-sessions-contract.js';
	import SidebarTagRecoveryNotice from './SidebarTagRecoveryNotice.svelte';

	interface TagDialogState {
		chatId: string;
		chatTitle: string;
		baseTags: readonly string[];
		editingTags: readonly string[];
	}

	interface SidebarTagDialogProps {
		tagDialog: TagDialogState | null;
		allKnownTags: string[];
		currentTags?: readonly string[];
		reconciliationKind?: ChatTagReconciliationKind;
		onClose: () => void;
		onSave: (chatId: string, baseTags: readonly string[], tags: string[]) => Promise<void> | void;
		onRetryReconciliation?: (chatId: string) => Promise<void> | void;
	}

	let {
		tagDialog,
		allKnownTags,
		currentTags,
		reconciliationKind = null,
		onClose,
		onSave,
		onRetryReconciliation,
	}: SidebarTagDialogProps = $props();

	let isOpen = $derived(tagDialog !== null);
	let editingTags = $state<string[]>([]);
	let inputValue = $state('');
	let inputRef = $state<HTMLInputElement | null>(null);
	let isSaving = $state(false);
	let isReconciling = $state(false);
	let saveError = $state<string | null>(null);
	let reconciliationError = $state<string | null>(null);
	let baseTags = $state<string[]>([]);

	$effect(() => {
		if (tagDialog) {
			baseTags = [...tagDialog.baseTags];
			editingTags = [...tagDialog.editingTags];
			inputValue = '';
			saveError = null;
			reconciliationError = null;
			isSaving = false;
			isReconciling = false;
		}
	});

	let latestTags = $derived(currentTags ?? tagDialog?.baseTags ?? []);
	let baselineOutdated = $derived(
		Boolean(tagDialog) && JSON.stringify(normalizeTags(baseTags)) !== JSON.stringify(normalizeTags(latestTags)),
	);
	let editsDisabled = $derived(
		isSaving || isReconciling || reconciliationKind !== null || baselineOutdated,
	);

	let suggestions = $derived.by(() => {
		const q = inputValue.trim().toLowerCase();
		if (!q) return [];
		const currentSet = new Set(editingTags.map((t) => t.toLowerCase()));
		return allKnownTags
			.filter((t) => t.toLowerCase().startsWith(q) && !currentSet.has(t.toLowerCase()))
			.slice(0, 5);
	});

	let unassignedTags = $derived.by(() => {
		const currentSet = new Set(editingTags.map((t) => t.toLowerCase()));
		return allKnownTags.filter((t) => !currentSet.has(t.toLowerCase()));
	});

	function normalizeTagSlug(raw: string): string {
		return raw
			.trim()
			.toLowerCase()
			.replace(/\s+/g, '-')
			.replace(/[^a-z0-9-]/g, '')
			.replace(/-{2,}/g, '-')
			.replace(/^-|-$/g, '');
	}

	function addTag(tag: string) {
		const normalized = normalizeTagSlug(tag);
		if (!normalized) return;
		if (editingTags.some((t) => t.toLowerCase() === normalized)) return;
		editingTags = [...editingTags, normalized];
		inputValue = '';
		inputRef?.focus();
	}

	function removeTag(tag: string) {
		editingTags = editingTags.filter((t) => t !== tag);
	}

	function handleInputKeydown(e: KeyboardEvent) {
		if (e.key === 'Enter' || e.key === ',') {
			e.preventDefault();
			saveError = null;
			if (inputValue.trim()) {
				addTag(inputValue);
			}
		} else if (e.key === 'Backspace' && !inputValue && editingTags.length > 0) {
			editingTags = editingTags.slice(0, -1);
		} else if (e.key === 'Escape') {
			e.preventDefault();
			e.stopPropagation();
			onClose();
		}
	}

	function tagsForSave(): string[] {
		const pending = inputValue.trim();
		if (!pending) return editingTags;
		const normalized = pending.toLowerCase();
		if (editingTags.some((tag) => tag.toLowerCase() === normalized)) {
			return editingTags;
		}
		return [...editingTags, normalized];
	}

	async function handleSave() {
		if (!tagDialog) return;
		isSaving = true;
		saveError = null;
		try {
			await onSave(tagDialog.chatId, baseTags, tagsForSave());
		} catch (error) {
			saveError = error instanceof Error ? error.message : String(error);
		} finally {
			isSaving = false;
		}
	}

	async function retryReconciliation(): Promise<void> {
		if (!tagDialog || !onRetryReconciliation || isReconciling || !reconciliationKind) return;
		const requestedKind = reconciliationKind;
		isReconciling = true;
		reconciliationError = null;
		try {
			await onRetryReconciliation(tagDialog.chatId);
			saveError = null;
		} catch {
			reconciliationError = isChatTagRefreshRequired(requestedKind)
				? m.chat_tags_refresh_failed()
				: m.chat_tags_confirmation_failed();
		} finally {
			isReconciling = false;
		}
	}

	function reviewLatestTags(): void {
		const normalizedBaseTags = normalizeTags(baseTags);
		const normalizedDraftTags = normalizeTags(tagsForSave());
		const normalizedLatestTags = normalizeTags(latestTags);
		const baseTagSet = new Set(normalizedBaseTags);
		const draftTagSet = new Set(normalizedDraftTags);
		const removedTags = new Set(normalizedBaseTags.filter((tag) => !draftTagSet.has(tag)));
		const addedTags = normalizedDraftTags.filter((tag) => !baseTagSet.has(tag));

		baseTags = normalizedLatestTags;
		editingTags = normalizeTags([
			...normalizedLatestTags.filter((tag) => !removedTags.has(tag)),
			...addedTags,
		]);
		inputValue = '';
		saveError = null;
		reconciliationError = null;
	}

	function requestClose() {
		if (isSaving || isReconciling) return;
		onClose();
	}

	function handleOpenChange(open: boolean) {
		if (!open) requestClose();
	}
</script>

<Dialog.Root open={isOpen} onOpenChange={handleOpenChange}>
	<Dialog.Content
		class="max-w-md"
		showCloseButton={!isSaving && !isReconciling}
		escapeKeydownBehavior={isSaving || isReconciling ? 'ignore' : 'close'}
		interactOutsideBehavior={isSaving || isReconciling ? 'ignore' : 'close'}
	>
		<Dialog.Header>
			<Dialog.Title>{m.sidebar_tags_manage()}</Dialog.Title>
			<Dialog.Description class="truncate">
				{tagDialog?.chatTitle || m.sidebar_chats_unnamed()}
			</Dialog.Description>
		</Dialog.Header>

		<div class="space-y-3">
			{#if editingTags.length > 0}
				<div class="flex flex-wrap gap-1.5">
					{#each editingTags as tag (tag)}
						<button
							type="button"
							class="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium hover:opacity-80 transition-opacity {getTagColorClasses(
								tag,
							)}"
							aria-label={m.sidebar_tags_remove({ tag })}
							disabled={editsDisabled}
							onclick={() => removeTag(tag)}
						>
							{tag}
							<X class="w-3 h-3" />
						</button>
					{/each}
				</div>
			{/if}

			<div class="relative">
				<Input
					bind:ref={inputRef}
					type="text"
					placeholder={m.sidebar_tags_input_placeholder()}
					aria-label={m.sidebar_tags_input_placeholder()}
					bind:value={inputValue}
					disabled={editsDisabled}
					onkeydown={handleInputKeydown}
					class="text-base sm:pointer-fine:text-sm"
				/>
				{#if suggestions.length > 0}
					<div
						class="absolute z-10 mt-1 w-full rounded-md border border-border bg-popover shadow-md"
					>
						{#each suggestions as suggestion (suggestion)}
							<button
								type="button"
								class="w-full text-left px-3 py-1.5 text-sm hover:bg-accent transition-colors first:rounded-t-md last:rounded-b-md"
								disabled={editsDisabled}
								onclick={() => addTag(suggestion)}
							>
								{suggestion}
							</button>
						{/each}
					</div>
				{/if}
			</div>

			{#if unassignedTags.length > 0 && !inputValue.trim() && !editsDisabled}
				<div class="space-y-1.5">
					<span class="text-xs font-medium text-muted-foreground"
						>{m.sidebar_tags_quick_assign()}</span
					>
					<div class="flex flex-wrap gap-1.5">
						{#each unassignedTags as tag (tag)}
							<ColoredTag
								label={tag}
								autoColor
								onclick={() => addTag(tag)}
								class="cursor-pointer hover:opacity-80 transition-opacity"
							/>
						{/each}
					</div>
				</div>
			{/if}

			{#if editingTags.length === 0 && allKnownTags.length === 0}
				<p class="text-sm text-muted-foreground italic">{m.sidebar_tags_no_tags()}</p>
			{/if}

			<SidebarTagRecoveryNotice
				{reconciliationKind}
				{baselineOutdated}
				reconciling={isReconciling}
				{reconciliationError}
				onRetry={() => void retryReconciliation()}
				onReviewLatest={reviewLatestTags}
			/>

			{#if saveError}
				<p class="text-sm text-destructive" role="alert">{saveError}</p>
			{/if}
		</div>

		<Dialog.Footer>
			<Button variant="outline" onclick={requestClose} disabled={isSaving || isReconciling}
				>{m.sidebar_actions_cancel()}</Button
			>
			<Button
				onclick={() => {
					void handleSave();
				}}
				disabled={editsDisabled}>{m.sidebar_actions_save()}</Button
			>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
