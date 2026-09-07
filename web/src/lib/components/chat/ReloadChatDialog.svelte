<script lang="ts">
	import * as Dialog from '$lib/components/ui/dialog';
	import { Button } from '$lib/components/ui/button';
	import * as m from '$lib/paraglide/messages.js';
	import type { ResendCandidate } from '$shared/chat-view';

	let {
		open,
		candidates,
		busy,
		onCancel,
		onConfirm,
	}: {
		open: boolean;
		candidates: readonly ResendCandidate[];
		busy: boolean;
		onCancel: () => void;
		onConfirm: () => void;
	} = $props();

	function handleOpenChange(next: boolean): void {
		if (!next && !busy) onCancel();
	}
</script>

<Dialog.Root {open} onOpenChange={handleOpenChange}>
	<Dialog.Content class="sm:max-w-lg">
		<Dialog.Header>
			<Dialog.Title>{m.sidebar_chats_reload_confirm_title()}</Dialog.Title>
			<Dialog.Description>
				{m.sidebar_chats_reload_confirm_description()}
			</Dialog.Description>
		</Dialog.Header>
		{#if candidates.length > 0}
			<section class="space-y-2" aria-label={m.sidebar_chats_reload_confirm_resend()}>
				<p class="text-sm font-medium">{m.sidebar_chats_reload_confirm_resend()}</p>
				<ul class="max-h-48 divide-y divide-border overflow-y-auto border-y border-border">
					{#each candidates as candidate (candidate.ordinal)}
						<svelte:boundary>
							<li class="min-w-0 py-2 text-sm">
								<p class="line-clamp-2 break-words">{candidate.content}</p>
								{#if candidate.attachmentNames.length > 0}
									<p class="mt-1 truncate text-xs text-muted-foreground">
										{candidate.attachmentNames.join(', ')}
									</p>
								{/if}
							</li>
							{#snippet failed()}
								<li class="py-2 text-sm text-muted-foreground">...</li>
							{/snippet}
						</svelte:boundary>
					{/each}
				</ul>
			</section>
		{/if}
		<Dialog.Footer>
			<Button variant="outline" disabled={busy} onclick={onCancel}>
				{m.sidebar_actions_cancel()}
			</Button>
			<Button variant="destructive" disabled={busy} onclick={onConfirm}>
				{m.sidebar_chats_reload_confirm_button()}
			</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
