<script lang="ts">
	import * as Dialog from '$lib/components/ui/dialog';
	import { Button } from '$lib/components/ui/button';
	import Input from '$lib/components/ui/input/input.svelte';
	import X from '@lucide/svelte/icons/x';
	import * as m from '$lib/paraglide/messages.js';
	import type { ChatFolderFilter } from '$lib/api/settings';
	import { isEmptyFilter } from '$lib/sidebar/search/sidebar-search.js';

	export interface FolderDialogState {
		mode: 'create' | 'edit';
		folderId?: string;
		filter: ChatFolderFilter;
		suggestedName: string;
	}

	interface SidebarSaveFolderDialogProps {
		saveFolderDialog: FolderDialogState | null;
		onClose: () => void;
		onSave: (name: string, filter: ChatFolderFilter, folderId?: string) => Promise<void> | void;
	}

	let { saveFolderDialog, onClose, onSave }: SidebarSaveFolderDialogProps = $props();

	let isOpen = $derived(saveFolderDialog !== null);
	let folderName = $state('');
	let inputRef = $state<HTMLInputElement | null>(null);
	let isSaving = $state(false);
	let saveError = $state<string | null>(null);
	let editableFilter = $state<ChatFolderFilter>({
		textTokens: [],
		tags: [],
		agents: [],
		models: [],
		project: [],
	});

	$effect(() => {
		if (saveFolderDialog) {
			folderName = saveFolderDialog.suggestedName;
			editableFilter = {
				textTokens: [...saveFolderDialog.filter.textTokens],
				tags: saveFolderDialog.filter.tags.map((g) => [...g]),
				agents: [...saveFolderDialog.filter.agents],
				models: [...saveFolderDialog.filter.models],
				project: [...saveFolderDialog.filter.project],
				...(saveFolderDialog.filter.status ? { status: saveFolderDialog.filter.status } : {}),
			};
			saveError = null;
			isSaving = false;
		}
	});

	$effect(() => {
		if (inputRef && saveFolderDialog) {
			inputRef.focus();
			inputRef.select();
		}
	});

	let isFilterEmpty = $derived(isEmptyFilter(editableFilter));

	interface PreviewChip {
		label: string;
		type: 'status' | 'text' | 'tag' | 'agent' | 'model';
		value: string;
	}

	let previewChips = $derived.by(() => {
		const chips: PreviewChip[] = [];
		if (editableFilter.status === 'active')
			chips.push({ label: m.sidebar_folders_filter_active(), type: 'status', value: 'active' });
		if (editableFilter.status === 'unread')
			chips.push({ label: m.sidebar_chat_unread(), type: 'status', value: 'unread' });
		for (const token of editableFilter.textTokens) {
			chips.push({ label: `"${token}"`, type: 'text', value: token });
		}
		for (const tagGroup of editableFilter.tags) {
			chips.push({ label: `tag:${tagGroup.join('|')}`, type: 'tag', value: tagGroup.join('|') });
		}
		for (const agent of editableFilter.agents) {
			chips.push({ label: `agent:${agent}`, type: 'agent', value: agent });
		}
		for (const model of editableFilter.models) {
			chips.push({ label: `model:${model}`, type: 'model', value: model });
		}
		return chips;
	});

	function removeChip(chip: PreviewChip) {
		if (chip.type === 'status') {
			editableFilter = { ...editableFilter, status: undefined };
		} else if (chip.type === 'text') {
			editableFilter = {
				...editableFilter,
				textTokens: editableFilter.textTokens.filter((t) => t !== chip.value),
			};
		} else if (chip.type === 'tag') {
			editableFilter = {
				...editableFilter,
				tags: editableFilter.tags.filter((g) => g.join('|') !== chip.value),
			};
		} else if (chip.type === 'agent') {
			editableFilter = {
				...editableFilter,
				agents: editableFilter.agents.filter((p) => p !== chip.value),
			};
		} else if (chip.type === 'model') {
			editableFilter = {
				...editableFilter,
				models: editableFilter.models.filter((m) => m !== chip.value),
			};
		}
	}

	function requestClose() {
		if (isSaving) return;
		onClose();
	}

	function handleOpenChange(open: boolean) {
		if (!open) requestClose();
	}

	async function handleSave() {
		if (!saveFolderDialog || isFilterEmpty) return;
		const name = folderName.trim();
		if (!name) return;
		isSaving = true;
		saveError = null;
		try {
			await onSave(name, editableFilter, saveFolderDialog.folderId);
		} catch (error) {
			saveError = error instanceof Error ? error.message : String(error);
		} finally {
			isSaving = false;
		}
	}

	function handleInputKeydown(event: KeyboardEvent) {
		if (event.key === 'Enter') {
			event.preventDefault();
			handleSave();
			return;
		}

		if (event.key === 'Escape') {
			event.preventDefault();
			event.stopPropagation();
			requestClose();
		}
	}

	let dialogTitle = $derived(
		saveFolderDialog?.mode === 'edit'
			? m.sidebar_folders_edit_dialog_title()
			: m.sidebar_folders_save_dialog_title(),
	);
	let isCreateMode = $derived(saveFolderDialog?.mode !== 'edit');
</script>

<Dialog.Root open={isOpen} onOpenChange={handleOpenChange}>
	<Dialog.Content
		class="max-w-md"
		showCloseButton={!isSaving}
		escapeKeydownBehavior={isSaving ? 'ignore' : 'close'}
		interactOutsideBehavior={isSaving ? 'ignore' : 'close'}
	>
		<Dialog.Header>
			<Dialog.Title>{dialogTitle}</Dialog.Title>
			{#if isCreateMode}
				<Dialog.Description>
					{m.sidebar_folders_save_dialog_description()}
				</Dialog.Description>
			{/if}
		</Dialog.Header>

		<div class="space-y-4">
			<label class="block space-y-1.5">
				<span class="text-sm font-medium text-foreground">{m.sidebar_folders_name_label()}</span>
				<Input
					bind:ref={inputRef}
					type="text"
					bind:value={folderName}
					disabled={isSaving}
					placeholder={m.sidebar_folders_name_placeholder()}
					onkeydown={handleInputKeydown}
				/>
			</label>

			<div class="space-y-2">
				<div class="text-sm font-medium text-foreground">{m.sidebar_folders_filter_preview()}</div>
				<div class="flex flex-wrap gap-1.5">
					{#each previewChips as chip (chip.label)}
						<span
							class="inline-flex items-center gap-1 rounded-full border border-border bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground"
						>
							{chip.label}
							<button
								type="button"
								class="ml-0.5 rounded-full p-0 hover:text-foreground transition-colors"
								onclick={() => removeChip(chip)}
								disabled={isSaving}
								aria-label={m.sidebar_remove_item({ name: chip.label })}
							>
								<X class="w-3 h-3" />
							</button>
						</span>
					{/each}
				</div>
			</div>

			{#if saveError}
				<p class="text-sm text-destructive">{saveError}</p>
			{/if}
		</div>

		<Dialog.Footer>
			<Button variant="outline" onclick={requestClose} disabled={isSaving}
				>{m.sidebar_actions_cancel()}</Button
			>
			<Button
				onclick={() => {
					void handleSave();
				}}
				disabled={!folderName.trim() || isFilterEmpty || isSaving}
				>{m.sidebar_actions_save()}</Button
			>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
