<script lang="ts">
	import { Button } from '$lib/components/ui/button';
	import * as Dialog from '$lib/components/ui/dialog';
	import { getAppShell } from '$lib/context';
	import type { NewChatPreambleChoice } from '$lib/chat/new-chat/new-chat-preamble-selection-state.svelte.js';
	import type { PreambleSelectionPreviewResponse } from '$lib/api/chat-preambles.js';
	import ChatPreambleSelectionPanel from './ChatPreambleSelectionPanel.svelte';
	import * as m from '$lib/paraglide/messages.js';
	import type { PreambleId, PreambleSelectionProjection } from '$shared/preambles';
	import { tick } from 'svelte';

	interface Props {
		open: boolean;
		choice: NewChatPreambleChoice;
		defaultsIds: readonly PreambleId[];
		previewLoading: boolean;
		canLoadAutomaticPreview: boolean;
		canonicalProjectPath: string;
		projection: PreambleSelectionProjection | null;
		onClose: () => void;
		onApplyExplicit: (ids: readonly PreambleId[]) => void;
		onApplyDefaults: () => void;
		onLoadAutomaticPreview: () => Promise<PreambleSelectionPreviewResponse>;
		onRefreshPreview: () => void | Promise<void>;
	}

	type AutomaticPreviewState =
		| { readonly status: 'parent' }
		| { readonly status: 'loading' }
		| { readonly status: 'ready'; readonly preview: PreambleSelectionPreviewResponse }
		| { readonly status: 'error' };

	let {
		open,
		choice,
		defaultsIds,
		previewLoading,
		canLoadAutomaticPreview,
		canonicalProjectPath,
		projection,
		onClose,
		onApplyExplicit,
		onApplyDefaults,
		onLoadAutomaticPreview,
		onRefreshPreview,
	}: Props = $props();

	const appShell = getAppShell();
	let draftIds = $state<PreambleId[]>([]);
	let draftMode = $state<NewChatPreambleChoice['mode']>('defaults');
	let hasManualChanges = $state(false);
	let automaticPreview = $state<AutomaticPreviewState>({ status: 'parent' });
	let automaticPreviewVersion = 0;
	let wasOpen = false;

	function initialDraftIds(
		currentChoice: NewChatPreambleChoice,
		currentDefaults: readonly PreambleId[],
	): PreambleId[] {
		if (currentChoice.mode === 'explicit') return [...currentChoice.orderedPreambleIds];
		return [...currentDefaults];
	}

	// Automatic drafts follow catalog updates until the user changes them.
	// Explicit drafts retain their exact membership and order.
	$effect(() => {
		if (!open) {
			if (wasOpen) automaticPreviewVersion += 1;
			wasOpen = false;
			return;
		}
		if (!wasOpen) {
			draftIds = initialDraftIds(choice, defaultsIds);
			draftMode = choice.mode;
			hasManualChanges = false;
			automaticPreview = { status: 'parent' };
			wasOpen = true;
			return;
		}
		if (
			choice.mode === 'defaults' &&
			draftMode === 'defaults' &&
			!hasManualChanges &&
			projection !== null
		) {
			draftIds = [...defaultsIds];
			automaticPreview = { status: 'parent' };
		}
	});

	const displayedProjection = $derived.by(() => {
		switch (automaticPreview.status) {
			case 'parent':
				return projection;
			case 'ready':
				return automaticPreview.preview.projection;
			case 'loading':
			case 'error':
				return null;
		}
	});
	const displayedCanonicalProjectPath = $derived.by(() => {
		if (automaticPreview.status === 'ready') {
			return automaticPreview.preview.canonicalProjectPath;
		}
		return canonicalProjectPath;
	});
	const automaticPreviewLoading = $derived(automaticPreview.status === 'loading');
	const automaticDefaultsUnavailable = $derived(
		draftMode === 'defaults' && displayedProjection === null,
	);
	const applyDisabled = $derived(automaticPreviewLoading || automaticDefaultsUnavailable);

	function move(id: PreambleId, direction: 'up' | 'down'): void {
		const index = draftIds.indexOf(id);
		const target = direction === 'up' ? index - 1 : index + 1;
		if (index < 0 || target < 0 || target >= draftIds.length) return;
		draftMode = 'explicit';
		hasManualChanges = true;
		const next = [...draftIds];
		[next[index], next[target]] = [next[target], next[index]];
		draftIds = next;
	}

	function remove(id: PreambleId): void {
		draftMode = 'explicit';
		hasManualChanges = true;
		draftIds = draftIds.filter((entry) => entry !== id);
	}

	function add(id: PreambleId): void {
		draftMode = 'explicit';
		hasManualChanges = true;
		if (!draftIds.includes(id)) draftIds = [...draftIds, id];
	}

	function handleApply(): void {
		if (applyDisabled) return;
		if (draftMode === 'defaults') {
			if (choice.mode === 'explicit') onApplyDefaults();
		} else if (hasManualChanges) {
			onApplyExplicit(draftIds);
		}
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
			void restorePickerAfterCatalog();
		});
	}

	async function restorePickerAfterCatalog(): Promise<void> {
		await refreshAutomaticDraftAfterCatalogChange();
		await tick();
		const opener = document.querySelector<HTMLElement>(
			'[data-slot="new-chat-preamble-manage-catalog"]',
		);
		opener?.focus({ preventScroll: true });
	}

	async function loadAutomaticDraft(): Promise<void> {
		const version = ++automaticPreviewVersion;
		draftMode = 'defaults';
		automaticPreview = { status: 'loading' };
		try {
			const nextPreview = await onLoadAutomaticPreview();
			if (!isCurrentAutomaticPreview(version)) return;
			automaticPreview = { status: 'ready', preview: nextPreview };
			draftIds = [...nextPreview.orderedPreambleIds];
			hasManualChanges = false;
		} catch {
			if (!isCurrentAutomaticPreview(version)) return;
			automaticPreview = { status: 'error' };
		}
	}

	function isCurrentAutomaticPreview(version: number): boolean {
		return version === automaticPreviewVersion && open;
	}

	async function refreshAutomaticDraftAfterCatalogChange(): Promise<void> {
		if (draftMode === 'defaults' && choice.mode === 'explicit') {
			await loadAutomaticDraft();
		}
	}

	function handleReset(): void {
		if (!canLoadAutomaticPreview) return;
		if (choice.mode === 'defaults' && projection !== null) {
			draftMode = 'defaults';
			draftIds = [...defaultsIds];
			hasManualChanges = false;
			automaticPreview = { status: 'parent' };
			return;
		}
		void loadAutomaticDraft();
	}

	function retryPreview(): void {
		if (draftMode === 'defaults' && choice.mode === 'explicit') {
			if (!canLoadAutomaticPreview) return;
			void loadAutomaticDraft();
			return;
		}
		void onRefreshPreview();
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
			<Dialog.Description class="sr-only">
				{m.preamble_selection_next_message_hint()}
			</Dialog.Description>
		</Dialog.Header>

		<div
			data-slot="new-chat-preamble-scroll-body"
			class="min-h-0 flex-1 overflow-y-auto px-5 py-4 text-base sm:px-6"
		>
			{#if automaticDefaultsUnavailable || automaticPreviewLoading}
				<div
					class="mb-3 flex items-center gap-2 rounded-md border border-border bg-muted/30 px-3 py-2"
					role={previewLoading || automaticPreviewLoading ? 'status' : 'alert'}
					data-slot="new-chat-preamble-preview-status"
				>
					<p class="min-w-0 flex-1 text-sm text-muted-foreground">
						{#if previewLoading || automaticPreviewLoading}
							{m.preamble_selection_loading()}
						{:else}
							{m.preamble_selection_preview_unavailable()}
						{/if}
					</p>
					{#if !previewLoading && !automaticPreviewLoading}
						<Button
							variant="outline"
							size="sm"
							data-slot="new-chat-preamble-preview-retry"
							onclick={retryPreview}
						>
							{m.preamble_selection_refresh()}
						</Button>
					{/if}
				</div>
			{/if}
			<ChatPreambleSelectionPanel
				{draftIds}
				projection={displayedProjection}
				canonicalProjectPath={displayedCanonicalProjectPath}
				disabled={automaticDefaultsUnavailable || automaticPreviewLoading}
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
					disabled={draftMode === 'defaults' || automaticPreviewLoading || !canLoadAutomaticPreview}
					onclick={handleReset}
				>
					{m.preamble_selection_reset_defaults()}
				</Button>
				<Button variant="outline" data-slot="new-chat-preamble-cancel" onclick={onClose}>
					{m.preambles_cancel()}
				</Button>
				<Button type="submit" data-slot="new-chat-preamble-apply" disabled={applyDisabled}>
					{m.preamble_selection_apply()}
				</Button>
			</div>
		</form>
	</Dialog.Content>
</Dialog.Root>
