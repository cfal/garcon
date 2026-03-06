<script lang="ts">
	import * as m from '$lib/paraglide/messages.js';
	import * as Dialog from '$lib/components/ui/dialog';
	import { Button } from '$lib/components/ui/button';
	import { Textarea } from '$lib/components/ui/textarea';
	import Copy from '@lucide/svelte/icons/copy';
	import Check from '@lucide/svelte/icons/check';
	import { copyToClipboard } from '$lib/utils/clipboard';
	import type { SessionProvider } from '$lib/types/app';

	interface ChatDeleteConfirmation {
		chatId: string;
		chatTitle: string;
		provider: SessionProvider;
	}

	interface ChatRenameConfirmation {
		chatId: string;
		currentName: string;
	}

	interface ChatDetailsDialog {
		chatId: string;
		chatTitle: string;
		firstMessage: string | null;
		createdAt: string | null;
		lastActivityAt: string | null;
		nativePath: string | null;
		isLoading: boolean;
		error: string | null;
	}

	interface SidebarChatDialogsProps {
		chatDeleteConfirmation: ChatDeleteConfirmation | null;
		onCancelDelete: () => void;
		onConfirmDelete: () => void;
		chatRenameConfirmation: ChatRenameConfirmation | null;
		onCancelRename: () => void;
		onConfirmRename: (newName: string) => void;
		chatDetailsDialog: ChatDetailsDialog | null;
		onCloseDetails: () => void;
	}

	let {
		chatDeleteConfirmation,
		onCancelDelete,
		onConfirmDelete,
		chatRenameConfirmation,
		onCancelRename,
		onConfirmRename,
		chatDetailsDialog,
		onCloseDetails,
	}: SidebarChatDialogsProps = $props();

	let renameValue = $state('');
	let renameInputRef = $state<HTMLInputElement | null>(null);
	let firstMessageCopied = $state(false);
	let nativePathCopied = $state(false);

	// Tracks whether the delete dialog is open via binding.
	let deleteOpen = $derived(chatDeleteConfirmation !== null);
	let renameOpen = $derived(chatRenameConfirmation !== null);
	let detailsOpen = $derived(chatDetailsDialog !== null);

	// Populate rename field whenever confirmation payload changes.
	$effect(() => {
		if (chatRenameConfirmation) {
			renameValue = chatRenameConfirmation.currentName;
		}
	});

	// Auto-focus and select the rename input when it appears.
	$effect(() => {
		if (renameInputRef && chatRenameConfirmation) {
			renameInputRef.focus();
			renameInputRef.setSelectionRange(0, renameInputRef.value.length);
		}
	});

	function handleRenameKeydown(e: KeyboardEvent) {
		if (e.key === 'Enter') {
			onConfirmRename(renameValue);
		} else if (e.key === 'Escape') {
			onCancelRename();
		}
	}

	function handleDeleteOpenChange(open: boolean) {
		if (!open) onCancelDelete();
	}

	function handleRenameOpenChange(open: boolean) {
		if (!open) onCancelRename();
	}

	function handleDetailsOpenChange(open: boolean) {
		if (!open) onCloseDetails();
	}

	function formatHumanDate(value: string | null): string {
		if (!value) return m.sidebar_details_unavailable();
		const parsed = new Date(value);
		if (Number.isNaN(parsed.getTime())) return value;
		return parsed.toLocaleString(undefined, {
			dateStyle: 'medium',
			timeStyle: 'short',
		});
	}

	function displayText(value: string | null): string {
		return value || '';
	}

	async function copyField(
		e: MouseEvent,
		text: string | null,
		onCopied: (v: boolean) => void,
	) {
		const value = displayText(text);
		if (!value) return;

		const container =
			(e.currentTarget as HTMLElement)?.closest('[role="dialog"]') ??
			undefined;
		const copied = await copyToClipboard(value, container);
		if (!copied) return;

		onCopied(true);
		setTimeout(() => onCopied(false), 2000);
	}
</script>

<!-- Delete confirmation dialog -->
<Dialog.Root open={deleteOpen} onOpenChange={handleDeleteOpenChange}>
	<Dialog.Content>
		<Dialog.Header class="min-w-0">
			<Dialog.Title>{m.sidebar_delete_confirmation_delete_chat()}</Dialog.Title>
			<Dialog.Description class="min-w-0 max-w-full">
				<span class="font-medium text-foreground block w-full min-w-0 max-w-full truncate">
					{chatDeleteConfirmation?.chatTitle || m.sidebar_chats_unnamed()}
				</span>
				{m.sidebar_delete_confirmation_cannot_undo()}
			</Dialog.Description>
		</Dialog.Header>
		<Dialog.Footer>
			<Button variant="outline" onclick={onCancelDelete}>{m.sidebar_actions_cancel()}</Button>
			<Button variant="destructive" onclick={onConfirmDelete} autofocus>{m.sidebar_actions_delete()}</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>

<!-- Rename dialog -->
<Dialog.Root open={renameOpen} onOpenChange={handleRenameOpenChange}>
	<Dialog.Content>
		<Dialog.Header>
			<Dialog.Title>{m.sidebar_chats_rename_chat()}</Dialog.Title>
			<input
				bind:this={renameInputRef}
				type="text"
				bind:value={renameValue}
				onkeydown={handleRenameKeydown}
				class="w-full px-3 py-2 text-base sm:text-sm border border-border rounded-lg bg-background text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/20 focus-visible:border-primary"
			/>
		</Dialog.Header>
		<Dialog.Footer>
			<Button variant="outline" onclick={onCancelRename}>{m.sidebar_actions_cancel()}</Button>
			<Button onclick={() => onConfirmRename(renameValue)}>{m.sidebar_actions_save()}</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>

<!-- Details dialog -->
<Dialog.Root open={detailsOpen} onOpenChange={handleDetailsOpenChange}>
	<Dialog.Content class="max-w-2xl overflow-hidden p-0 sm:max-h-[85vh]">
		<Dialog.Header class="px-6 pt-6 pb-1">
			<Dialog.Title class="truncate">
				{chatDetailsDialog?.chatTitle || m.sidebar_chats_unnamed()}
			</Dialog.Title>
		</Dialog.Header>

		{#if chatDetailsDialog?.isLoading}
			<div class="px-6 py-6 text-sm text-muted-foreground">{m.sidebar_details_loading()}</div>
		{:else if chatDetailsDialog?.error}
			<div class="px-6 py-6 text-sm text-destructive">{chatDetailsDialog.error}</div>
		{:else}
			<div class="min-w-0 max-h-[65vh] overflow-y-auto overflow-x-hidden px-6 pt-1 pb-6 sm:max-h-[60vh]">
				<div class="space-y-4 min-w-0">
				<div class="space-y-1">
					<div class="text-sm font-medium">{m.sidebar_details_created_at()}</div>
					<div class="text-sm text-muted-foreground">{formatHumanDate(chatDetailsDialog?.createdAt || null)}</div>
				</div>
				<div class="space-y-1">
					<div class="text-sm font-medium">{m.sidebar_details_last_activity()}</div>
					<div class="text-sm text-muted-foreground">{formatHumanDate(chatDetailsDialog?.lastActivityAt || null)}</div>
				</div>
				<div class="space-y-1">
					<div class="flex items-center justify-between gap-2">
						<div class="text-sm font-medium">{m.sidebar_details_native_path()}</div>
						<button
							type="button"
							class="inline-flex items-center justify-center text-muted-foreground hover:text-foreground transition-colors"
							onclick={(e) => copyField(e, chatDetailsDialog?.nativePath || null, (v) => nativePathCopied = v)}
							title={m.chat_tool_display_copy_to_clipboard()}
							aria-label={m.chat_tool_display_copy_to_clipboard()}
						>
							{#if nativePathCopied}
								<Check class="w-4 h-4 text-status-success-foreground" />
							{:else}
								<Copy class="w-4 h-4" />
							{/if}
						</button>
					</div>
					<Textarea
						readonly
						rows={2}
						value={displayText(chatDetailsDialog?.nativePath || null)}
						class="w-full max-w-full min-w-0 resize-none min-h-16 font-mono text-xs"
					/>
				</div>
				<div class="space-y-1">
					<div class="flex items-center justify-between gap-2">
						<div class="text-sm font-medium">{m.sidebar_details_first_message()}</div>
						<button
							type="button"
							class="inline-flex items-center justify-center text-muted-foreground hover:text-foreground transition-colors"
							onclick={(e) => copyField(e, chatDetailsDialog?.firstMessage || null, (v) => firstMessageCopied = v)}
							title={m.chat_tool_display_copy_to_clipboard()}
							aria-label={m.chat_tool_display_copy_to_clipboard()}
						>
							{#if firstMessageCopied}
								<Check class="w-4 h-4 text-status-success-foreground" />
							{:else}
								<Copy class="w-4 h-4" />
							{/if}
						</button>
					</div>
					<Textarea
						readonly
						rows={8}
						value={displayText(chatDetailsDialog?.firstMessage || null)}
						class="w-full max-w-full min-w-0 h-40 max-h-[40vh] resize-none overflow-y-auto font-mono text-xs"
					/>
				</div>
			</div>
			</div>
		{/if}
	</Dialog.Content>
</Dialog.Root>
