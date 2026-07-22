<script lang="ts">
	import { tick } from 'svelte';
	import Loader2 from '@lucide/svelte/icons/loader-2';
	import RefreshCw from '@lucide/svelte/icons/refresh-cw';
	import * as Dialog from '$lib/components/ui/dialog';
	import type { UserMessageNavigatorDialogController } from '$lib/chat/transcript/user-message-navigator-controller.svelte.js';
	import * as m from '$lib/paraglide/messages.js';

	const LOAD_THRESHOLD_PX = 96;

	interface Props {
		controller: UserMessageNavigatorDialogController;
	}

	let { controller }: Props = $props();
	let listElement: HTMLDivElement | null = $state(null);

	function handleOpenChange(open: boolean): void {
		if (!open) controller.close();
	}

	function isNearListBottom(): boolean {
		if (!listElement) return false;
		return (
			listElement.scrollHeight - listElement.scrollTop - listElement.clientHeight <
			LOAD_THRESHOLD_PX
		);
	}

	function maybeLoadOlder(): void {
		if (!controller.open || controller.isLoadingOlder || controller.loadError) return;
		if (controller.hasMore && isNearListBottom()) void controller.loadOlder();
	}

	function handleScroll(): void {
		maybeLoadOlder();
	}

	$effect(() => {
		const open = controller.open;
		const isLoading = controller.isLoadingOlder;
		const hasMore = controller.hasMore;
		const loadError = controller.loadError;
		const element = listElement;
		if (!open || isLoading || !hasMore || loadError || !element) return;
		const itemCount = controller.items.length;
		let cancelled = false;

		void tick().then(() => {
			if (cancelled || listElement !== element || controller.items.length < itemCount) return;
			maybeLoadOlder();
		});

		return () => {
			cancelled = true;
		};
	});
</script>

{#snippet failed(_error: unknown)}
	<div class="flex min-h-16 items-center px-5 py-3 text-sm text-destructive sm:px-6" role="alert">
		{m.chat_user_message_navigator_row_render_failed()}
	</div>
{/snippet}

<Dialog.Root open={controller.open} onOpenChange={handleOpenChange}>
	<Dialog.Content
		class="flex h-dvh max-h-dvh w-screen max-w-none flex-col gap-0 overflow-hidden rounded-none border-0 p-0 sm:h-[80dvh] sm:max-h-[44rem] sm:max-w-2xl sm:rounded-lg sm:border"
		showCloseButton={true}
	>
		<Dialog.Header class="shrink-0 border-b border-border px-5 py-4 sm:px-6">
			<Dialog.Title class="text-lg font-semibold">
				{m.chat_user_message_navigator_title()}
			</Dialog.Title>
			<Dialog.Description class="sr-only">
				{m.chat_user_message_navigator_description()}
			</Dialog.Description>
		</Dialog.Header>

		<div
			bind:this={listElement}
			onscroll={handleScroll}
			class="min-h-0 flex-1 overflow-y-auto"
			data-user-message-navigator-list
		>
			{#if controller.selectionError === 'target-unavailable'}
				<div class="border-b border-border px-5 py-3 text-sm text-destructive sm:px-6" role="alert">
					{m.chat_user_message_navigator_target_unavailable()}
				</div>
			{/if}

			{#if controller.isInitialLoading}
				<div
					class="flex min-h-40 items-center justify-center gap-2 px-5 py-10 text-sm text-muted-foreground"
					role="status"
					aria-label={m.chat_user_message_navigator_loading()}
				>
					<Loader2 class="h-4 w-4 animate-spin" aria-hidden="true" />
					{m.chat_user_message_navigator_loading()}
				</div>
			{:else if controller.initialLoadError === 'initial-load-failed'}
				<div
					class="flex min-h-40 flex-col items-center justify-center gap-4 px-5 py-10 text-center"
					role="alert"
				>
					<p class="text-sm text-destructive">{m.chat_feed_failed_to_load()}</p>
					<button
						type="button"
						class="inline-flex min-h-9 items-center gap-2 rounded-md border border-border px-3 text-sm font-medium text-foreground hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
						onclick={() => void controller.retryInitialLoad()}
					>
						<RefreshCw class="h-4 w-4" aria-hidden="true" />
						{m.chat_user_message_navigator_retry()}
					</button>
				</div>
			{:else if controller.items.length === 0 && !controller.hasMore}
				<div
					class="flex min-h-40 items-center justify-center px-5 py-10 text-center text-sm text-muted-foreground"
				>
					{m.chat_user_message_navigator_empty()}
				</div>
			{:else}
				<div class="divide-y divide-border">
					{#each controller.items as item (item.id)}
						<svelte:boundary {failed}>
							<button
								type="button"
								class="flex min-h-16 w-full items-center px-5 py-3 text-start hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring sm:px-6"
								onclick={() => void controller.select(item)}
								data-user-message-navigator-row={item.id}
							>
								<span
									class="line-clamp-2 w-full whitespace-pre-wrap break-words text-sm leading-5 text-foreground"
								>
									{item.content.trim() || m.chat_user_message_navigator_attachment_only()}
								</span>
							</button>
						</svelte:boundary>
					{/each}
				</div>
			{/if}

			{#if controller.isLoadingOlder}
				<div
					class="flex items-center justify-center gap-2 border-t border-border px-5 py-4 text-sm text-muted-foreground"
					role="status"
				>
					<Loader2 class="h-4 w-4 animate-spin" aria-hidden="true" />
					{m.chat_user_message_navigator_loading_older()}
				</div>
			{:else if controller.loadError === 'older-page-failed'}
				<div
					class="flex items-center justify-between gap-3 border-t border-border px-5 py-3 sm:px-6"
					role="alert"
				>
					<p class="text-sm text-destructive">
						{m.chat_user_message_navigator_load_failed()}
					</p>
					<button
						type="button"
						class="inline-flex min-h-9 shrink-0 items-center gap-2 rounded-md border border-border px-3 text-sm font-medium text-foreground hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
						onclick={() => void controller.retryLoadOlder()}
					>
						<RefreshCw class="h-4 w-4" aria-hidden="true" />
						{m.chat_user_message_navigator_retry()}
					</button>
				</div>
			{/if}
		</div>
	</Dialog.Content>
</Dialog.Root>
