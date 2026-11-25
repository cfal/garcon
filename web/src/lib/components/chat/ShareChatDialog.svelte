<script lang="ts">
	import * as m from '$lib/paraglide/messages.js';
	import * as Dialog from '$lib/components/ui/dialog';
	import { Button } from '$lib/components/ui/button';
	import Copy from '@lucide/svelte/icons/copy';
	import Check from '@lucide/svelte/icons/check';
	import Trash2 from '@lucide/svelte/icons/trash-2';
	import Loader2 from '@lucide/svelte/icons/loader-2';
	import Link from '@lucide/svelte/icons/link';
	import { shareChat, revokeShare } from '$lib/api/shares.js';
	import { ChatClipboardFeedback } from './chat-clipboard-feedback.svelte.js';

	interface ShareChatDialogProps {
		chatId: string | null;
		onClose: () => void;
	}

	let { chatId, onClose }: ShareChatDialogProps = $props();

	let dialogOpen = $derived(chatId !== null);
	let isLoading = $state(false);
	let shareUrl = $state<string | null>(null);
	let error = $state<string | null>(null);
	let isRevoking = $state(false);
	let showRevokeConfirm = $state(false);
	const clipboard = new ChatClipboardFeedback();
	let requestGeneration = 0;

	// Triggers share creation when chatId changes.
	$effect(() => {
		const id = chatId;
		const generation = ++requestGeneration;
		shareUrl = null;
		error = null;
		isRevoking = false;
		showRevokeConfirm = false;
		isLoading = id !== null;
		if (id) void createOrUpdateShare(id, generation);
		return () => {
			requestGeneration += 1;
			clipboard.reset();
		};
	});

	function isCurrent(id: string, generation: number): boolean {
		return chatId === id && generation === requestGeneration;
	}

	async function createOrUpdateShare(id: string, generation: number) {
		try {
			const result = await shareChat(id);
			if (!isCurrent(id, generation)) return;
			if (result.success) {
				shareUrl = window.location.origin + result.shareUrl;
			} else {
				error = m.share_dialog_error();
			}
		} catch {
			if (isCurrent(id, generation)) error = m.share_dialog_error();
		} finally {
			if (isCurrent(id, generation)) isLoading = false;
		}
	}

	function handleCopyLink(event: MouseEvent): Promise<void> {
		const container = (event.currentTarget as HTMLElement)?.closest('[role="dialog"]') ?? undefined;
		return clipboard.copy(shareUrl, container);
	}

	async function handleRevoke() {
		const id = chatId;
		if (!id) return;
		const generation = requestGeneration;
		isRevoking = true;
		try {
			await revokeShare(id);
			if (!isCurrent(id, generation)) return;
			shareUrl = null;
			showRevokeConfirm = false;
			onClose();
		} catch {
			if (isCurrent(id, generation)) error = m.share_dialog_revoke_failed();
		} finally {
			if (isCurrent(id, generation)) isRevoking = false;
		}
	}

	function handleOpenChange(open: boolean) {
		if (!open) onClose();
	}
</script>

<Dialog.Root open={dialogOpen} onOpenChange={handleOpenChange}>
	<Dialog.Content class="sm:max-w-xl">
		<Dialog.Header>
			<Dialog.Title>{m.share_dialog_title()}</Dialog.Title>
			<Dialog.Description>{m.share_dialog_description()}</Dialog.Description>
		</Dialog.Header>

		{#if isLoading}
			<div class="flex items-center justify-center gap-2 py-8 text-muted-foreground">
				<Loader2 class="w-4 h-4 animate-spin" />
				<span class="text-sm">{m.share_dialog_creating()}</span>
			</div>
		{:else if error}
			<div class="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
				{error}
			</div>
		{:else if shareUrl}
			<div class="rounded-lg border bg-muted/50 px-3 py-2.5 flex items-center gap-2.5 min-w-0">
				<Link class="w-4 h-4 flex-shrink-0 text-muted-foreground" />
				<span class="text-sm truncate select-all flex-1" title={shareUrl}>{shareUrl}</span>
			</div>

			<Dialog.Footer class="sm:justify-between">
				{#if !showRevokeConfirm}
					<button
						type="button"
						class="text-xs text-muted-foreground hover:text-destructive transition-colors"
						onclick={() => {
							showRevokeConfirm = true;
						}}
					>
						{m.share_dialog_revoke()}
					</button>
				{:else}
					<div
						class="flex items-center gap-2 flex-1 p-2.5 rounded-lg bg-destructive/5 border border-destructive/20"
					>
						<span class="text-xs text-destructive flex-1">{m.share_dialog_revoke_confirm()}</span>
						<Button variant="destructive" size="sm" onclick={handleRevoke} disabled={isRevoking}>
							{#if isRevoking}
								<Loader2 class="w-3 h-3 animate-spin" />
							{:else}
								<Trash2 class="w-3 h-3" />
							{/if}
							{m.share_dialog_revoke()}
						</Button>
						<Button
							variant="ghost"
							size="sm"
							onclick={() => {
								showRevokeConfirm = false;
							}}
						>
							{m.sidebar_actions_cancel()}
						</Button>
					</div>
				{/if}
				<Button onclick={handleCopyLink} variant={clipboard.copied ? 'outline' : 'default'}>
					{#if clipboard.copied}
						<Check class="w-4 h-4" />
						{m.share_dialog_link_copied()}
					{:else}
						<Copy class="w-4 h-4" />
						{m.share_dialog_copy_link()}
					{/if}
				</Button>
			</Dialog.Footer>
		{/if}
	</Dialog.Content>
</Dialog.Root>
