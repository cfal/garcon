<script lang="ts">
	import * as Dialog from '$lib/components/ui/dialog';
	import { Button } from '$lib/components/ui/button';
	import Input from '$lib/components/ui/input/input.svelte';
	import * as m from '$lib/paraglide/messages.js';
	import X from '@lucide/svelte/icons/x';
	import ColoredTag from '../shared/ColoredTag.svelte';
	import { getTagColorClasses } from '$lib/utils/tag-colors';
	import { normalizeTags } from '$shared/tags';
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
		recoveryRequired?: boolean;
		onClose: () => void;
		onSave: (chatId: string, baseTags: readonly string[], tags: string[]) => Promise<void> | void;
		onRetryRecovery?: (chatId: string) => Promise<void> | void;
	}

	let {
		tagDialog,
		allKnownTags,
		currentTags,
		recoveryRequired = false,
		onClose,
		onSave,
		onRetryRecovery,
	}: SidebarTagDialogProps = $props();

	let isOpen = $derived(tagDialog !== null);
	let editingTags = $state<string[]>([]);
	let inputValue = $state('');
	let inputRef = $state<HTMLInputElement | null>(null);
	let isSaving = $state(false);
	let isRecovering = $state(false);
	let saveError = $state<string | null>(null);
	let recoveryError = $state<string | null>(null);
	let baseTags = $state<string[]>([]);

	$effect(() => {
		if (tagDialog) {
			baseTags = [...tagDialog.baseTags];
			editingTags = [...tagDialog.editingTags];
			inputValue = '';
			saveError = null;
			recoveryError = null;
			isSaving = false;
			isRecovering = false;
		}
	});

	let latestTags = $derived(currentTags ?? tagDialog?.baseTags ?? []);
	let baselineOutdated = $derived(
		Boolean(tagDialog) && JSON.stringify(normalizeTags(baseTags)) !== JSON.stringify(normalizeTags(latestTags)),
	);
	let editsDisabled = $derived(isSaving || isRecovering || recoveryRequired || baselineOutdated);

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

	async function retryRecovery(): Promise<void> {
		if (!tagDialog || !onRetryRecovery || isRecovering) return;
		isRecovering = true;
		recoveryError = null;
		try {
			await onRetryRecovery(tagDialog.chatId);
			saveError = null;
		} catch {
			recoveryError = m.chat_tags_confirmation_failed();
		} finally {
			isRecovering = false;
		}
	}

	function reviewLatestTags(): void {
		baseTags = [...latestTags];
		saveError = null;
		recoveryError = null;
	}

	function requestClose() {
		if (isSaving || isRecovering) return;
		onClose();
	}

	function handleOpenChange(open: boolean) {
		if (!open) requestClose();
	}
</script>

<Dialog.Root open={isOpen} onOpenChange={handleOpenChange}>
	<Dialog.Content
		class="max-w-md"
		showCloseButton={!isSaving && !isRecovering}
		escapeKeydownBehavior={isSaving || isRecovering ? 'ignore' : 'close'}
		interactOutsideBehavior={isSaving || isRecovering ? 'ignore' : 'close'}
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
				{recoveryRequired}
				{baselineOutdated}
				recovering={isRecovering}
				{recoveryError}
				onRetry={() => void retryRecovery()}
				onReviewLatest={reviewLatestTags}
			/>

			{#if saveError}
				<p class="text-sm text-destructive" role="alert">{saveError}</p>
			{/if}
		</div>

		<Dialog.Footer>
			<Button variant="outline" onclick={requestClose} disabled={isSaving || isRecovering}
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
