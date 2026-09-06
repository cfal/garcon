<script lang="ts">
	import Loader2 from '@lucide/svelte/icons/loader-2';
	import RefreshCw from '@lucide/svelte/icons/refresh-cw';
	import { Button } from '$lib/components/ui/button';
	import * as Dialog from '$lib/components/ui/dialog';
	import { getAppShell, getChatPreambleSelectionInvalidationHub } from '$lib/context';
	import { ChatPreambleSelectionController } from '$lib/preambles/chat-selection-controller.svelte.js';
	import ChatPreambleSelectionPanel from './ChatPreambleSelectionPanel.svelte';
	import * as m from '$lib/paraglide/messages.js';
	import { tick } from 'svelte';

	const appShell = getAppShell();
	const hub = getChatPreambleSelectionInvalidationHub();

	const controller = new ChatPreambleSelectionController({ hub });
	const target = $derived(appShell.chatPreambleSelectionTarget);

	$effect(() => {
		if (target) void controller.open(target);
	});

	// Destruction cleanup: subscriptions and outstanding responses never
	// outlive conditional component destruction.
	$effect(() => {
		return () => controller.close();
	});

	function handleOpenChange(nextOpen: boolean): void {
		if (!nextOpen && !appShell.showPreambles) appShell.closeChatPreambleSelection();
	}

	function handleSaveSubmit(event: SubmitEvent): void {
		event.preventDefault();
		void controller.save();
	}

	function handleKeydown(event: KeyboardEvent): void {
		if (event.key !== 'Enter' || (!event.metaKey && !event.ctrlKey)) return;
		event.preventDefault();
		if (controller.canSave) void controller.save();
	}

	function openCatalog(): void {
		appShell.openPreambles(() => {
			void tick().then(() => {
				const opener = document.querySelector<HTMLElement>(
					'[data-slot="chat-preamble-selection-manage-catalog"]',
				);
				opener?.focus({ preventScroll: true });
			});
		});
	}
</script>

<Dialog.Root
	open={target !== null && !appShell.showPreambles}
	onOpenChange={handleOpenChange}
>
	<Dialog.Content
		data-slot="chat-preamble-selection-dialog"
		class="top-[var(--app-viewport-center-y)] flex h-[var(--app-height)] max-h-[var(--app-height)] w-screen max-w-none flex-col gap-0 overflow-hidden rounded-none border-0 p-0 sm:w-screen sm:max-w-none sm:pointer-fine:top-[50%] sm:pointer-fine:h-[min(40rem,calc(var(--app-height)-2rem))] sm:pointer-fine:max-h-[40rem] sm:pointer-fine:w-[calc(100vw-2rem)] sm:pointer-fine:max-w-2xl sm:pointer-fine:rounded-lg sm:pointer-fine:border"
		showCloseButton={true}
		onkeydown={handleKeydown}
	>
		<Dialog.Header class="shrink-0 border-b border-border px-5 py-4 sm:px-6">
			<Dialog.Title class="text-lg font-semibold">
				{m.preamble_selection_dialog_title()}
			</Dialog.Title>
			<Dialog.Description>{m.preamble_selection_next_message_hint()}</Dialog.Description>
		</Dialog.Header>

		<div
			data-slot="chat-preamble-selection-scroll-body"
			class="min-h-0 flex-1 overflow-y-auto px-5 py-4 text-base sm:px-6"
		>
			{#if controller.status === 'loading'}
				<p class="text-sm text-muted-foreground" data-slot="chat-preamble-selection-status" role="status">
					{m.preamble_selection_loading()}
				</p>
			{:else if controller.status === 'error'}
				<p class="text-sm text-destructive" data-slot="chat-preamble-selection-status" role="alert">
					{controller.error}
				</p>
			{:else if controller.status === 'idle'}
				<div data-slot="chat-preamble-selection-status"></div>
			{:else}
				{#if controller.error}
					<p
						class="mb-3 rounded-md border border-border bg-muted/40 px-3 py-2 text-sm text-destructive"
						data-slot="chat-preamble-selection-error"
						role="alert"
					>
						{controller.error}
					</p>
				{/if}
				{#if controller.conflict}
					<div
						class="mb-3 flex flex-wrap items-center gap-2 rounded-md border border-border bg-muted/40 px-3 py-2 text-sm text-muted-foreground"
						data-slot="chat-preamble-selection-conflict"
						role="status"
					>
						<span class="min-w-0 flex-1">{m.preamble_selection_conflict()}</span>
						<Button
							variant="outline"
							size="sm"
							data-slot="chat-preamble-selection-rebase"
							disabled={controller.saving}
							onclick={() => void controller.refreshBase()}
						>
							<RefreshCw class="h-3.5 w-3.5" />
							{m.preamble_selection_refresh()}
						</Button>
					</div>
				{/if}
				{#if controller.partialWarning}
					<p
						class="mb-3 rounded-md border border-border bg-muted/40 px-3 py-2 text-sm text-muted-foreground"
						data-slot="chat-preamble-selection-partial-warning"
						role="status"
					>
						{controller.partialWarning.message}
					</p>
				{/if}
				{#if controller.status === 'refresh-required'}
					<div
						class="mb-3 flex flex-wrap items-center gap-2 rounded-md border border-border bg-muted/40 px-3 py-2 text-sm text-muted-foreground"
						data-slot="chat-preamble-selection-refresh-required"
						role="status"
					>
						<span class="min-w-0 flex-1">
							{controller.partialWarning?.message ?? m.preamble_selection_refresh_required()}
						</span>
						<Button
							variant="outline"
							size="sm"
							data-slot="chat-preamble-selection-retry-refresh"
							onclick={() => void controller.refreshBase()}
						>
							<RefreshCw class="h-3.5 w-3.5" />
							{m.preamble_selection_refresh()}
						</Button>
					</div>
				{/if}
				<ChatPreambleSelectionPanel
					draftIds={controller.draftIds}
					projection={controller.projection}
					canonicalProjectPath={controller.canonicalProjectPath}
					disabled={controller.saving}
					onMove={(id, direction) => controller.move(id, direction)}
					onRemove={(id) => controller.remove(id)}
					onAdd={(id) => controller.add(id)}
				/>
				<div class="mt-3 flex flex-wrap items-center gap-2">
					<Button
						variant="ghost"
						size="sm"
						data-slot="chat-preamble-selection-manage-catalog"
						onclick={openCatalog}
					>
						{m.preamble_selection_manage_catalog()}
					</Button>
				</div>
			{/if}
		</div>

		<form
			class="flex shrink-0 items-center justify-end gap-2 border-t border-border px-5 py-3 sm:px-6"
			onsubmit={handleSaveSubmit}
		>
			<Button
				type="button"
				variant="outline"
				data-slot="chat-preamble-selection-cancel"
				onclick={() => handleOpenChange(false)}
				disabled={controller.saving}
			>
				{m.preambles_cancel()}
			</Button>
			<Button
				type="submit"
				data-slot="chat-preamble-selection-save"
				disabled={!controller.canSave}
				aria-busy={controller.saving}
			>
				{#if controller.saving}
					<Loader2 class="h-4 w-4 animate-spin" aria-hidden="true" />
					{m.preamble_selection_saving()}
				{:else}
					{m.preamble_selection_save()}
				{/if}
			</Button>
		</form>
	</Dialog.Content>
</Dialog.Root>
