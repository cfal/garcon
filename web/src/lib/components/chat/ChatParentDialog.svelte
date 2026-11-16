<script lang="ts">
	import { tick, untrack } from 'svelte';
	import type { Attachment } from 'svelte/attachments';
	import { getOptionalTransientLayers } from '$lib/context';
	import * as Dialog from '$lib/components/ui/dialog';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import Loader2 from '@lucide/svelte/icons/loader-2';
	import Unlink from '@lucide/svelte/icons/unlink';
	import Check from '@lucide/svelte/icons/check';
	import type { ChatSessionRecord } from '$lib/chat/sessions/chat-session-types';
	import type { ChatParentDialogTarget } from './chat-action-dialogs-state.svelte';
	import { eligibleParentChats, matchParentChats, typedParentId } from './chat-parent-candidates';
	import * as m from '$lib/paraglide/messages.js';

	let {
		parentDialog,
		chats,
		isConnected,
		executorLabel,
		onRefresh,
		onClose,
		onConfirm,
	}: {
		parentDialog: ChatParentDialogTarget | null;
		chats: readonly ChatSessionRecord[];
		isConnected: boolean;
		executorLabel: (id?: string | null) => string;
		onRefresh: () => void | Promise<void>;
		onClose: () => void;
		onConfirm: (chatId: string, parentChatId: string | null) => Promise<void>;
	} = $props();

	type ParentChoice = { kind: 'unset' } | { kind: 'chat'; chatId: string } | { kind: 'clear' };
	let choice = $state<ParentChoice>({ kind: 'unset' });
	let query = $state('');
	let submitting = $state(false);
	let errorMessage = $state<string | null>(null);
	let suggestionsOpen = $state(true);
	let highlightedId = $state<string | null>(null);
	let inputRef = $state<HTMLInputElement | null>(null);
	let activeDialog = $state.raw<ChatParentDialogTarget | null>(null);
	let focusOrigin: { trigger: HTMLElement; panel: HTMLElement; chatId: string } | null = null;
	const uid = $props.id();
	const transientLayers = getOptionalTransientLayers();
	const suggestionsLayer: Attachment = (element) =>
		transientLayers?.register({
			id: `${uid}-suggestions`,
			kind: 'popover',
			modality: 'nonmodal',
			isOpen: () => suggestionsOpen && parentDialog !== null,
			element: () => element as HTMLElement,
			onEscape: () => {
				suggestionsOpen = false;
				return true;
			},
			restoreFocus: () => inputRef?.focus({ preventScroll: true }),
		});
	const child = $derived(chats.find((chat) => chat.id === parentDialog?.chatId));
	const currentParent = $derived(child?.parentChat ?? null);
	const currentTitle = $derived(chats.find((chat) => chat.id === currentParent?.chatId)?.title);
	const protectedLineage = $derived(
		currentParent !== null && currentParent.relation !== 'delegation',
	);
	const eligible = $derived(eligibleParentChats(chats, parentDialog?.chatId ?? ''));
	const suggestions = $derived(matchParentChats(eligible, query));
	const activeSuggestion = $derived(
		suggestionsOpen ? suggestions.find((chat) => chat.id === highlightedId) : undefined,
	);
	const selectedId = $derived(choice.kind === 'chat' ? choice.chatId : undefined);
	const selected = $derived(chats.find((chat) => chat.id === selectedId));
	const proposedId = $derived(
		choice.kind === 'clear' ? null : choice.kind === 'chat' ? choice.chatId : typedParentId(query),
	);
	const canSubmit = $derived(
		Boolean(
			child &&
			child.status !== 'draft' &&
			!protectedLineage &&
			isConnected &&
			!submitting &&
			proposedId !== undefined,
		),
	);

	$effect(() => {
		const target = parentDialog;
		untrack(() => {
			if (target === activeDialog) return;
			activeDialog = target;
			query = '';
			choice = { kind: 'unset' };
			submitting = false;
			errorMessage = null;
			suggestionsOpen = true;
			highlightedId = null;
			if (!target) return;
			const trigger = document.activeElement;
			const panel = trigger?.closest<HTMLElement>('[data-conversation-panel]');
			focusOrigin =
				trigger instanceof HTMLElement && panel ? { trigger, panel, chatId: target.chatId } : null;
			void onRefresh();
		});
	});

	function select(chat: ChatSessionRecord): void {
		if (submitting) return;
		choice = { kind: 'chat', chatId: chat.id };
		query = chat.id;
		suggestionsOpen = false;
		highlightedId = null;
		errorMessage = null;
	}

	function handleKeydown(event: KeyboardEvent): void {
		if (event.isComposing || event.keyCode === 229) {
			if (event.key === 'Escape') event.stopPropagation();
			return;
		}
		if (submitting) return;
		if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
			event.preventDefault();
			suggestionsOpen = true;
			const current = suggestions.findIndex((chat) => chat.id === highlightedId);
			const next =
				event.key === 'ArrowDown'
					? (current + 1) % suggestions.length
					: current <= 0
						? suggestions.length - 1
						: current - 1;
			highlightedId = suggestions[next]?.id ?? null;
			void tick().then(() =>
				document.getElementById(`${uid}-${highlightedId}`)?.scrollIntoView({ block: 'nearest' }),
			);
		} else if (event.key === 'Enter') {
			event.preventDefault();
			if (activeSuggestion) select(activeSuggestion);
			else void submit();
		} else if (event.key === 'Escape' && suggestionsOpen) {
			event.preventDefault();
			event.stopPropagation();
			suggestionsOpen = false;
		}
	}

	async function submit(): Promise<void> {
		const target = parentDialog;
		const parentId = proposedId;
		if (!canSubmit || !target || parentId === undefined) return;
		submitting = true;
		errorMessage = null;
		try {
			await onConfirm(target.chatId, parentId);
			if (parentDialog === target) onClose();
		} catch (error) {
			if (parentDialog === target)
				errorMessage = error instanceof Error ? error.message : String(error);
		} finally {
			if (parentDialog === target) submitting = false;
		}
	}

	function restoreFocus(event: Event): void {
		if (parentDialog) return;
		const origin = focusOrigin;
		focusOrigin = null;
		if (!origin) return;
		if (origin.panel.dataset.conversationPanelChatId !== origin.chatId) {
			event.preventDefault();
			return;
		}
		if (!origin.trigger.isConnected) {
			event.preventDefault();
			origin.panel
				.querySelector<HTMLElement>('[data-chat-scroll-viewport]')
				?.focus({ preventScroll: true });
		}
	}
</script>

<Dialog.Root
	open={parentDialog !== null}
	requestClose={() => {
		if (!submitting) onClose();
	}}
>
	<Dialog.Content
		class="max-h-[calc(100dvh-2rem)] overflow-y-auto"
		onCloseAutoFocus={restoreFocus}
		onOpenAutoFocus={(event) => {
			if (!protectedLineage) {
				event.preventDefault();
				queueMicrotask(() => inputRef?.focus());
			}
		}}
	>
		<Dialog.Header>
			<Dialog.Title>{m.chat_parent_title()}</Dialog.Title>
			<Dialog.Description class="truncate">{parentDialog?.chatTitle}</Dialog.Description>
		</Dialog.Header>
		<div class="min-w-0 space-y-1 text-sm">
			<p class="text-muted-foreground">{m.chat_parent_current()}</p>
			{#if currentParent}
				{#if currentTitle}<p class="truncate">{currentTitle}</p>{/if}
				<p class="break-all font-mono text-xs">{currentParent.chatId}</p>
			{:else}<p>{m.chat_parent_none()}</p>{/if}
		</div>
		{#if !child}
			<p role="status" class="text-sm text-destructive">{m.chat_parent_missing()}</p>
		{:else if protectedLineage}
			<p class="text-sm text-muted-foreground">{m.chat_parent_protected()}</p>
		{:else}
			<p class="text-sm text-muted-foreground">{m.chat_parent_authority()}</p>
			<div class="min-w-0 space-y-2">
				<label for={`${uid}-input`} class="text-sm font-medium">{m.chat_parent_label()}</label>
				<Input
					id={`${uid}-input`}
					bind:ref={inputRef}
					bind:value={query}
					role="combobox"
					autocomplete="off"
					aria-autocomplete="list"
					aria-expanded={suggestionsOpen}
					aria-controls={`${uid}-list`}
					aria-activedescendant={activeSuggestion ? `${uid}-${activeSuggestion.id}` : undefined}
					aria-describedby={`${uid}-feedback`}
					readonly={submitting}
					aria-busy={submitting}
					placeholder={m.chat_parent_placeholder()}
					oninput={() => {
						choice = { kind: 'unset' };
						highlightedId = null;
						suggestionsOpen = true;
						errorMessage = null;
					}}
					onkeydown={handleKeydown}
				/>
				{#if choice.kind === 'chat'}
					<p class="flex min-w-0 items-center gap-2 text-sm">
						<Check class="size-4 shrink-0" /><span class="truncate"
							>{selected?.title || choice.chatId}</span
						>
					</p>
				{:else if choice.kind === 'clear'}
					<p role="status" class="text-sm">{m.chat_parent_clearing()}</p>
				{/if}
				{#if suggestionsOpen}
					<div
						{@attach suggestionsLayer}
						id={`${uid}-list`}
						role="listbox"
						aria-label={m.chat_parent_matches()}
						class="max-h-64 overflow-y-auto rounded-md border border-border"
					>
						{#each suggestions as chat (chat.id)}
							<button
								type="button"
								role="option"
								id={`${uid}-${chat.id}`}
								aria-selected={activeSuggestion?.id === chat.id}
								tabindex="-1"
								disabled={submitting}
								onclick={() => select(chat)}
								onpointerdown={(event) => event.preventDefault()}
								class="block w-full min-w-0 border-b border-border px-3 py-2 text-left last:border-0 hover:bg-accent aria-selected:bg-accent"
							>
								<span class="block truncate text-sm font-medium"
									>{chat.title || m.sidebar_chats_unnamed()}</span
								>
								<span class="block font-mono text-xs">{chat.id}</span>
								<span class="block truncate text-xs text-muted-foreground"
									>{executorLabel(chat.executorId)} / {chat.projectPath}</span
								>
							</button>
						{/each}
					</div>
					<p role="status" class="text-xs text-muted-foreground">
						{suggestions.length
							? m.chat_parent_match_count({ count: suggestions.length })
							: m.chat_parent_no_matches()}
					</p>
				{/if}
				{#if currentParent}
					<Button
						variant="ghost"
						size="sm"
						disabled={submitting}
						onclick={() => {
							choice = { kind: 'clear' };
							query = '';
							suggestionsOpen = false;
							errorMessage = null;
						}}
					>
						<Unlink class="size-4" />{m.chat_parent_remove()}
					</Button>
				{/if}
			</div>
		{/if}
		<div id={`${uid}-feedback`} aria-live="polite">
			{#if errorMessage}<p role="alert" class="text-sm text-destructive">{errorMessage}</p>{/if}
			{#if !isConnected}<p class="text-sm text-muted-foreground">{m.chat_parent_offline()}</p>{/if}
		</div>
		<Dialog.Footer>
			<Button variant="outline" disabled={submitting} onclick={onClose}>{m.sidebar_actions_cancel()}</Button>
			{#if child && !protectedLineage}
				<Button disabled={!canSubmit} onclick={() => void submit()}>
					{#if submitting}<Loader2 class="size-4 animate-spin" />{/if}{m.chat_parent_save()}
				</Button>
			{/if}
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
