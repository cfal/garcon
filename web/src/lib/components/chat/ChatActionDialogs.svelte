<script lang="ts">
	import * as m from '$lib/paraglide/messages.js';
	import * as Dialog from '$lib/components/ui/dialog';
	import { Button } from '$lib/components/ui/button';
	import type {
		ChatDeleteConfirmation,
		ChatDetailsDialog,
		ChatRenameConfirmation,
	} from './chat-action-dialogs-state.svelte';
	import ChatDetailsTextField from './ChatDetailsTextField.svelte';

	interface ChatActionDialogsProps {
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
	}: ChatActionDialogsProps = $props();

	let renameValue = $state('');
	let renameInputRef = $state<HTMLInputElement | null>(null);
	let deleteButtonRef = $state<HTMLButtonElement | null>(null);

	let deleteOpen = $derived(chatDeleteConfirmation !== null);
	let renameOpen = $derived(chatRenameConfirmation !== null);
	let detailsOpen = $derived(chatDetailsDialog !== null);

	// Populates the rename field whenever a different chat opens the dialog.
	$effect(() => {
		if (chatRenameConfirmation) {
			renameValue = chatRenameConfirmation.currentName;
		}
	});

	// Selects the current title so repeated rename workflows can replace it quickly.
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
			e.preventDefault();
			e.stopPropagation();
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

	function displayModel(value: string): string {
		return value || m.sidebar_details_unavailable();
	}
</script>

<Dialog.Root open={deleteOpen} onOpenChange={handleDeleteOpenChange}>
	<Dialog.Content
		onOpenAutoFocus={(e) => {
			e.preventDefault();
			deleteButtonRef?.focus();
		}}
	>
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
			<Button variant="destructive" onclick={onConfirmDelete} bind:ref={deleteButtonRef}
				>{m.sidebar_actions_delete()}</Button
			>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>

<Dialog.Root open={renameOpen} onOpenChange={handleRenameOpenChange}>
	<Dialog.Content>
		<Dialog.Header>
			<Dialog.Title>{m.sidebar_chats_rename_chat()}</Dialog.Title>
			<input
				bind:this={renameInputRef}
				type="text"
				bind:value={renameValue}
				onkeydown={handleRenameKeydown}
				class="w-full px-3 py-2 text-base sm:pointer-fine:text-sm border border-border rounded-lg bg-background text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/20 focus-visible:border-primary"
			/>
		</Dialog.Header>
		<Dialog.Footer>
			<Button variant="outline" onclick={onCancelRename}>{m.sidebar_actions_cancel()}</Button>
			<Button onclick={() => onConfirmRename(renameValue)}>{m.sidebar_actions_save()}</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>

<Dialog.Root open={detailsOpen} onOpenChange={handleDetailsOpenChange}>
	<Dialog.Content class="max-w-2xl overflow-hidden p-0 sm:max-h-[85vh]">
		<Dialog.Header class="min-w-0 max-w-full overflow-hidden px-6 pt-6 pb-1 pr-12">
			<Dialog.Title class="block min-w-0 max-w-full truncate">
				{chatDetailsDialog?.chatTitle || m.sidebar_chats_unnamed()}
			</Dialog.Title>
		</Dialog.Header>

		{#if chatDetailsDialog?.isLoading}
			<div class="px-6 py-6 text-sm text-muted-foreground">{m.sidebar_details_loading()}</div>
		{:else if chatDetailsDialog?.error}
			<div class="px-6 py-6 text-sm text-destructive">{chatDetailsDialog.error}</div>
		{:else}
			<div
				class="min-w-0 max-h-[65vh] overflow-y-auto overflow-x-hidden px-6 pt-1 pb-6 sm:max-h-[60vh]"
			>
				<div class="space-y-4 min-w-0">
					<ChatDetailsTextField
						label={m.sidebar_details_chat_id()}
						value={chatDetailsDialog?.chatId ?? null}
						surfaceClass="min-h-12 max-h-24"
					/>
					<ChatDetailsTextField
						label={m.sidebar_details_project_path()}
						value={chatDetailsDialog?.projectPath ?? null}
						surfaceClass="min-h-12 max-h-24"
					/>
					{#if chatDetailsDialog?.carryOverSegments.length}
						<section class="min-w-0 space-y-2" aria-label={m.sidebar_details_carryover_history()}>
							<h3 class="text-sm font-medium">{m.sidebar_details_carryover_history()}</h3>
							<ol class="divide-y divide-border border-y border-border">
								{#each chatDetailsDialog.carryOverSegments as segment}
									<svelte:boundary>
										<li class="min-w-0 py-3 text-sm">
											<div class="min-w-0 break-words font-medium">
												{segment.agentId} / {displayModel(segment.model)}
												{#if segment.trailingHandoff}
													<span class="text-muted-foreground">
														-&gt; {segment.trailingHandoff.agentId} /
														{displayModel(segment.trailingHandoff.model)}
													</span>
												{/if}
											</div>
											<div
												class="mt-1 flex min-w-0 flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground"
											>
												<span>{formatHumanDate(segment.capturedAt)}</span>
												<span>
													{m.sidebar_details_carryover_messages({
														visible: segment.visibleMessageCount,
														stored: segment.storedMessageCount,
													})}
												</span>
												{#if segment.truncated}
													<span>{m.sidebar_details_carryover_truncated()}</span>
												{/if}
											</div>
											<div class="mt-1 break-all font-mono text-xs text-muted-foreground">
												{segment.id}
											</div>
										</li>
										{#snippet failed()}
											<li class="py-3 text-sm text-muted-foreground">
												{m.sidebar_details_unavailable()}
											</li>
										{/snippet}
									</svelte:boundary>
								{/each}
							</ol>
						</section>
					{/if}
					<div class="space-y-1">
						<div class="text-sm font-medium">{m.sidebar_details_created_at()}</div>
						<div class="text-sm text-muted-foreground">
							{formatHumanDate(chatDetailsDialog?.createdAt || null)}
						</div>
					</div>
					{#if chatDetailsDialog?.transcriptSource}
						<ChatDetailsTextField
							label={chatDetailsDialog.transcriptSource.kind === 'filesystem-path'
								? m.sidebar_details_native_path()
								: m.sidebar_details_native_reference()}
							value={chatDetailsDialog.transcriptSource.value}
							surfaceClass="min-h-12 max-h-24"
						/>
					{/if}
					<div class="space-y-1">
						<div class="text-sm font-medium">{m.sidebar_details_last_activity()}</div>
						<div class="text-sm text-muted-foreground">
							{formatHumanDate(chatDetailsDialog?.lastActivityAt || null)}
						</div>
					</div>
					<ChatDetailsTextField
						label={m.sidebar_details_agent_session_id()}
						value={chatDetailsDialog?.agentSessionId ?? null}
						surfaceClass="min-h-12 max-h-24"
					/>
					<ChatDetailsTextField
						label={m.sidebar_details_first_message()}
						value={chatDetailsDialog?.firstMessage ?? null}
						surfaceClass="h-32 max-h-[40vh]"
					/>
				</div>
			</div>
		{/if}
	</Dialog.Content>
</Dialog.Root>
