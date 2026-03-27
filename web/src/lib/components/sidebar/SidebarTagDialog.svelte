<script lang="ts">
	import * as Dialog from '$lib/components/ui/dialog';
	import { Button } from '$lib/components/ui/button';
	import Input from '$lib/components/ui/input/input.svelte';
	import * as m from '$lib/paraglide/messages.js';
	import X from '@lucide/svelte/icons/x';

	interface TagDialogState {
		chatId: string;
		chatTitle: string;
		tags: string[];
	}

	interface SidebarTagDialogProps {
		tagDialog: TagDialogState | null;
		allKnownTags: string[];
		onClose: () => void;
		onSave: (chatId: string, tags: string[]) => void;
	}

	let {
		tagDialog,
		allKnownTags,
		onClose,
		onSave,
	}: SidebarTagDialogProps = $props();

	let isOpen = $derived(tagDialog !== null);
	let editingTags = $state<string[]>([]);
	let inputValue = $state('');
	let inputRef = $state<HTMLInputElement | null>(null);

	$effect(() => {
		if (tagDialog) {
			editingTags = [...tagDialog.tags];
			inputValue = '';
		}
	});

	let suggestions = $derived.by(() => {
		const q = inputValue.trim().toLowerCase();
		if (!q) return [];
		const currentSet = new Set(editingTags.map((t) => t.toLowerCase()));
		return allKnownTags
			.filter((t) => t.toLowerCase().startsWith(q) && !currentSet.has(t.toLowerCase()))
			.slice(0, 5);
	});

	function addTag(tag: string) {
		const normalized = tag.trim().toLowerCase();
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
			if (inputValue.trim()) {
				addTag(inputValue);
			}
		} else if (e.key === 'Backspace' && !inputValue && editingTags.length > 0) {
			editingTags = editingTags.slice(0, -1);
		} else if (e.key === 'Escape') {
			onClose();
		}
	}

	function handleSave() {
		if (!tagDialog) return;
		onSave(tagDialog.chatId, editingTags);
	}

	function handleOpenChange(open: boolean) {
		if (!open) onClose();
	}
</script>

<Dialog.Root open={isOpen} onOpenChange={handleOpenChange}>
	<Dialog.Content class="max-w-md">
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
							class="inline-flex items-center gap-1 rounded-full border border-border bg-muted px-2 py-0.5 text-xs font-medium text-foreground hover:bg-accent transition-colors"
							aria-label={m.sidebar_tags_remove({ tag })}
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
					onkeydown={handleInputKeydown}
					class="text-sm"
				/>
				{#if suggestions.length > 0}
					<div class="absolute z-10 mt-1 w-full rounded-md border border-border bg-popover shadow-md">
						{#each suggestions as suggestion (suggestion)}
							<button
								type="button"
								class="w-full text-left px-3 py-1.5 text-sm hover:bg-accent transition-colors first:rounded-t-md last:rounded-b-md"
								onclick={() => addTag(suggestion)}
							>
								{suggestion}
							</button>
						{/each}
					</div>
				{/if}
			</div>
		</div>

		<Dialog.Footer>
			<Button variant="outline" onclick={onClose}>{m.sidebar_actions_cancel()}</Button>
			<Button onclick={handleSave}>{m.sidebar_actions_save()}</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
