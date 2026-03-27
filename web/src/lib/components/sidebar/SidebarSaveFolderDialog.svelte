<script lang="ts">
	import * as Dialog from '$lib/components/ui/dialog';
	import { Button } from '$lib/components/ui/button';
	import Input from '$lib/components/ui/input/input.svelte';
	import * as m from '$lib/paraglide/messages.js';
	import type { ChatFolderFilter } from '$lib/api/settings';

	interface SaveFolderDialogState {
		filter: ChatFolderFilter;
		suggestedName: string;
	}

	interface SidebarSaveFolderDialogProps {
		saveFolderDialog: SaveFolderDialogState | null;
		onClose: () => void;
		onSave: (name: string, filter: ChatFolderFilter) => void;
	}

	let {
		saveFolderDialog,
		onClose,
		onSave,
	}: SidebarSaveFolderDialogProps = $props();

	let isOpen = $derived(saveFolderDialog !== null);
	let folderName = $state('');
	let inputRef = $state<HTMLInputElement | null>(null);

	$effect(() => {
		if (saveFolderDialog) {
			folderName = saveFolderDialog.suggestedName;
		}
	});

	$effect(() => {
		if (inputRef && saveFolderDialog) {
			inputRef.focus();
			inputRef.select();
		}
	});

	let previewChips = $derived.by(() => {
		const filter = saveFolderDialog?.filter;
		if (!filter) return [];

		const chips: string[] = [];
		if (filter.status === 'active') chips.push(m.sidebar_folders_filter_active());
		if (filter.status === 'unread') chips.push(m.sidebar_chat_unread());
		chips.push(...filter.textTokens.map((token) => `"${token}"`));
		chips.push(...filter.tags.map((tag) => `tag:${tag}`));
		chips.push(...filter.providers.map((provider) => `provider:${provider}`));
		chips.push(...filter.models.map((model) => `model:${model}`));
		return chips;
	});

	function handleOpenChange(open: boolean) {
		if (!open) onClose();
	}

	function handleSave() {
		if (!saveFolderDialog) return;
		const name = folderName.trim();
		if (!name) return;
		onSave(name, saveFolderDialog.filter);
	}

	function handleInputKeydown(event: KeyboardEvent) {
		if (event.key === 'Enter') {
			event.preventDefault();
			handleSave();
			return;
		}

		if (event.key === 'Escape') {
			onClose();
		}
	}
</script>

<Dialog.Root open={isOpen} onOpenChange={handleOpenChange}>
	<Dialog.Content class="max-w-md">
		<Dialog.Header>
			<Dialog.Title>{m.sidebar_folders_save_dialog_title()}</Dialog.Title>
			<Dialog.Description>
				{m.sidebar_folders_save_dialog_description()}
			</Dialog.Description>
		</Dialog.Header>

		<div class="space-y-4">
			<label class="block space-y-1.5">
				<span class="text-sm font-medium text-foreground">{m.sidebar_folders_name_label()}</span>
				<Input
					bind:ref={inputRef}
					type="text"
					bind:value={folderName}
					placeholder={m.sidebar_folders_name_placeholder()}
					onkeydown={handleInputKeydown}
				/>
			</label>

			<div class="space-y-2">
				<div class="text-sm font-medium text-foreground">{m.sidebar_folders_filter_preview()}</div>
				<div class="flex flex-wrap gap-1.5">
					{#each previewChips as chip (chip)}
						<span class="inline-flex items-center rounded-full border border-border bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
							{chip}
						</span>
					{/each}
				</div>
			</div>
		</div>

		<Dialog.Footer>
			<Button variant="outline" onclick={onClose}>{m.sidebar_actions_cancel()}</Button>
			<Button onclick={handleSave} disabled={!folderName.trim()}>{m.sidebar_actions_save()}</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
