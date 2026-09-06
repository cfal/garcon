<script lang="ts">
	import { Button } from '$lib/components/ui/button';
	import * as Dialog from '$lib/components/ui/dialog';
	import { getAppShell } from '$lib/context';
	import ChatPreambleSelectionPanel from './ChatPreambleSelectionPanel.svelte';
	import * as m from '$lib/paraglide/messages.js';
	import type { PreambleId, PreambleSelectionProjection } from '$shared/preambles';
	import { tick } from 'svelte';

	interface Props {
		open: boolean;
		choice: { mode: 'defaults' } | { mode: 'explicit'; orderedPreambleIds: readonly PreambleId[] };
		defaultsIds: readonly PreambleId[];
		canonicalProjectPath: string;
		projection: PreambleSelectionProjection | null;
		onClose: () => void;
		onApplyExplicit: (ids: readonly PreambleId[]) => void;
		onResetToDefaults: () => void;
	}

	let {
		open,
		choice,
		defaultsIds,
		canonicalProjectPath,
		projection,
		onClose,
		onApplyExplicit,
		onResetToDefaults,
	}: Props = $props();

	const appShell = getAppShell();
	let draftIds = $state<PreambleId[]>([]);
	let touched = $state(false);
	let wasOpen = $state(false);

	// Seed strictly on the closed-to-open transition; later choice, defaults,
	// or catalog updates must not clobber an in-progress edit.
	$effect(() => {
		if (open && !wasOpen) {
			draftIds = choice.mode === 'explicit'
				? [...choice.orderedPreambleIds]
				: [...defaultsIds];
			touched = false;
		}
		wasOpen = open;
	});

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
		onApplyExplicit(draftIds);
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
			<ChatPreambleSelectionPanel
				draftIds={draftIds}
				{projection}
				{canonicalProjectPath}
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
				{m.preamble_selection_manage_catalog()}
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
				<Button
					type="submit"
					data-slot="new-chat-preamble-apply"
				>
					{m.preamble_selection_apply()}
				</Button>
			</div>
		</form>
	</Dialog.Content>
</Dialog.Root>
