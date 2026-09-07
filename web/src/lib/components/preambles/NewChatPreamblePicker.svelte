<script lang="ts">
	import { Button } from '$lib/components/ui/button';
	import * as Dialog from '$lib/components/ui/dialog';
	import { getAppShell } from '$lib/context';
	import type { NewChatPreambleChoice } from '$lib/chat/new-chat/new-chat-preamble-selection-state.svelte.js';
	import ChatPreambleSelectionPanel from './ChatPreambleSelectionPanel.svelte';
	import * as m from '$lib/paraglide/messages.js';
	import type { PreambleId, PreambleSelectionProjection } from '$shared/preambles';
	import { tick } from 'svelte';

	interface Props {
		open: boolean;
		choice: NewChatPreambleChoice;
		defaultsIds: readonly PreambleId[];
		previewLoading: boolean;
		canonicalProjectPath: string;
		projection: PreambleSelectionProjection | null;
		onClose: () => void;
		onApplyExplicit: (ids: readonly PreambleId[]) => void;
		onResetToDefaults: () => void;
		onRefreshPreview: () => void | Promise<void>;
	}

	let {
		open,
		choice,
		defaultsIds,
		previewLoading,
		canonicalProjectPath,
		projection,
		onClose,
		onApplyExplicit,
		onResetToDefaults,
		onRefreshPreview,
	}: Props = $props();

	const appShell = getAppShell();
	let draftIds = $state<PreambleId[]>([]);
	let touched = $state(false);
	let wasOpen = false;

	function initialDraftIds(
		currentChoice: NewChatPreambleChoice,
		currentDefaults: readonly PreambleId[],
	): PreambleId[] {
		if (currentChoice.mode === 'explicit') return [...currentChoice.orderedPreambleIds];
		return [...currentDefaults];
	}

	// Catalog updates follow automatic defaults until the user changes the draft.
	// Explicit and touched drafts retain their exact membership and order.
	$effect(() => {
		if (!open) {
			wasOpen = false;
			return;
		}
		if (!wasOpen) {
			draftIds = initialDraftIds(choice, defaultsIds);
			touched = false;
			wasOpen = true;
			return;
		}
		if (choice.mode === 'defaults' && !touched && projection !== null) {
			draftIds = [...defaultsIds];
		}
	});

	const automaticDefaultsUnavailable = $derived(
		choice.mode === 'defaults' && !touched && projection === null,
	);

	function move(id: PreambleId, direction: 'up' | 'down'): void {
		touched = true;
		const index = draftIds.indexOf(id);
		const target = direction === 'up' ? index - 1 : index + 1;
		if (index < 0 || target < 0 || target >= draftIds.length) return;
		const next = [...draftIds];
		[next[index], next[target]] = [next[target], next[index]];
		draftIds = next;
	}

	function remove(id: PreambleId): void {
		touched = true;
		draftIds = draftIds.filter((entry) => entry !== id);
	}

	function add(id: PreambleId): void {
		touched = true;
		if (!draftIds.includes(id)) draftIds = [...draftIds, id];
	}

	function handleApply(): void {
		if (touched) onApplyExplicit(draftIds);
		onClose();
	}

	function handleApplySubmit(event: SubmitEvent): void {
		event.preventDefault();
		handleApply();
	}

	function handleKeydown(event: KeyboardEvent): void {
		if (event.key !== 'Enter' || (!event.metaKey && !event.ctrlKey)) return;
		event.preventDefault();
		handleApply();
	}

	function handleOpenChange(nextOpen: boolean): void {
		if (!nextOpen && !appShell.showPreambles) onClose();
	}

	function openCatalog(): void {
		appShell.openPreambles(() => {
			void tick().then(() => {
				const opener = document.querySelector<HTMLElement>(
					'[data-slot="new-chat-preamble-manage-catalog"]',
				);
				opener?.focus({ preventScroll: true });
			});
		});
	}

	function handleReset(): void {
		onResetToDefaults();
		onClose();
	}
</script>

<Dialog.Root open={open && !appShell.showPreambles} onOpenChange={handleOpenChange}>
	<Dialog.Content
		data-slot="new-chat-preamble-selection-dialog"
		class="top-[var(--app-viewport-center-y)] flex h-[var(--app-height)] max-h-[var(--app-height)] w-screen max-w-none flex-col gap-0 overflow-hidden rounded-none border-0 p-0 sm:w-screen sm:max-w-none sm:pointer-fine:top-[50%] sm:pointer-fine:h-[min(38rem,calc(var(--app-height)-2rem))] sm:pointer-fine:max-h-[38rem] sm:pointer-fine:w-[calc(100vw-2rem)] sm:pointer-fine:max-w-xl sm:pointer-fine:rounded-lg sm:pointer-fine:border"
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
			data-slot="new-chat-preamble-scroll-body"
			class="min-h-0 flex-1 overflow-y-auto px-5 py-4 text-base sm:px-6"
		>
			{#if automaticDefaultsUnavailable}
				<div
					class="mb-3 flex items-center gap-2 rounded-md border border-border bg-muted/30 px-3 py-2"
					role={previewLoading ? 'status' : 'alert'}
					data-slot="new-chat-preamble-preview-status"
				>
					<p class="min-w-0 flex-1 text-sm text-muted-foreground">
						{previewLoading
							? m.preamble_selection_loading()
							: m.preamble_selection_preview_unavailable()}
					</p>
					{#if !previewLoading}
						<Button
							variant="outline"
							size="sm"
							data-slot="new-chat-preamble-preview-retry"
							onclick={() => void onRefreshPreview()}
						>
							{m.preamble_selection_refresh()}
						</Button>
					{/if}
				</div>
			{/if}
			<ChatPreambleSelectionPanel
				{draftIds}
				{projection}
				{canonicalProjectPath}
				disabled={automaticDefaultsUnavailable}
				onMove={move}
				onRemove={remove}
				onAdd={add}
			/>
		</div>

		<form
			class="flex shrink-0 flex-wrap items-center justify-between gap-2 border-t border-border px-5 py-3 sm:px-6"
			onsubmit={handleApplySubmit}
		>
			<Button
				variant="ghost"
				size="sm"
				data-slot="new-chat-preamble-manage-catalog"
				onclick={openCatalog}
			>
				{m.preamble_selection_manage_preambles()}
			</Button>
			<div class="flex items-center gap-2">
				<Button
					variant="ghost"
					size="sm"
					data-slot="new-chat-preamble-reset-defaults"
					disabled={choice.mode === 'defaults' && !touched}
					onclick={handleReset}
				>
					{m.preamble_selection_reset_defaults()}
				</Button>
				<Button variant="outline" data-slot="new-chat-preamble-cancel" onclick={onClose}>
					{m.preambles_cancel()}
				</Button>
				<Button type="submit" data-slot="new-chat-preamble-apply">
					{m.preamble_selection_apply()}
				</Button>
			</div>
		</form>
	</Dialog.Content>
</Dialog.Root>
