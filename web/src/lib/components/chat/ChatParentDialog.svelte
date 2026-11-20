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
	import { ChatParentDialogState } from './chat-parent-dialog-state.svelte';
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

	const form = new ChatParentDialogState({
		get target() {
			return parentDialog;
		},
		get chats() {
			return chats;
		},
		get isConnected() {
			return isConnected;
		},
		onConfirm: (chatId, parentChatId) => onConfirm(chatId, parentChatId),
		onClose: () => onClose(),
	});
	let inputRef = $state<HTMLInputElement | null>(null);
	let activeDialog: ChatParentDialogTarget | null = null;
	let focusOrigin: { trigger: HTMLElement; panel: HTMLElement; chatId: string } | null = null;
	const uid = $props.id();
	const transientLayers = getOptionalTransientLayers();
	const suggestionsLayer: Attachment<HTMLElement> = (element) =>
		transientLayers?.register({
			id: `${uid}-suggestions`,
			kind: 'popover',
			modality: 'nonmodal',
			isOpen: () => form.suggestionsOpen && parentDialog !== null,
			element: () => element,
			onEscape: () => {
				form.suggestionsOpen = false;
				return true;
			},
			restoreFocus: () => inputRef?.focus({ preventScroll: true }),
		});

	$effect(() => {
		const target = parentDialog;
		untrack(() => {
			if (target === activeDialog) return;
			activeDialog = target;
			form.reset();
			if (!target) return;
			const trigger = document.activeElement;
			const panel = trigger?.closest<HTMLElement>('[data-conversation-panel]');
			focusOrigin =
				trigger instanceof HTMLElement && panel ? { trigger, panel, chatId: target.chatId } : null;
			void onRefresh();
		});
	});

	function handleKeydown(event: KeyboardEvent): void {
		if (event.isComposing || event.keyCode === 229) {
			if (event.key === 'Escape') event.stopPropagation();
			return;
		}
		if (form.submitting) return;
		if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
			event.preventDefault();
			form.moveHighlight(event.key);
			void tick().then(() =>
				document
					.getElementById(`${uid}-${form.highlightedId}`)
					?.scrollIntoView({ block: 'nearest' }),
			);
		} else if (event.key === 'Enter') {
			event.preventDefault();
			if (form.activeSuggestion) form.select(form.activeSuggestion);
			else void form.submit();
		} else if (event.key === 'Escape' && form.suggestionsOpen) {
			event.preventDefault();
			event.stopPropagation();
			form.suggestionsOpen = false;
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
		if (!form.submitting) onClose();
	}}
>
	<Dialog.Content
		class="max-h-[calc(100dvh-2rem)] overflow-y-auto"
		onCloseAutoFocus={restoreFocus}
		onOpenAutoFocus={(event) => {
			event.preventDefault();
			queueMicrotask(() => inputRef?.focus());
		}}
	>
		<Dialog.Header>
			<Dialog.Title>{m.chat_parent_title()}</Dialog.Title>
			<Dialog.Description class="truncate">{parentDialog?.chatTitle}</Dialog.Description>
		</Dialog.Header>
		<div class="min-w-0 space-y-1 text-sm">
			<p class="text-muted-foreground">{m.chat_parent_current()}</p>
			{#if form.currentParentId}
				{#if form.currentTitle}<p class="truncate">{form.currentTitle}</p>{/if}
				<p class="break-all font-mono text-xs">{form.currentParentId}</p>
			{:else}<p>{m.chat_parent_none()}</p>{/if}
		</div>
		{#if !form.child}
			<p role="status" class="text-sm text-destructive">{m.chat_parent_missing()}</p>
		{:else}
			<p class="text-sm text-muted-foreground">{m.chat_parent_authority()}</p>
			<div class="min-w-0 space-y-2">
				<label for={`${uid}-input`} class="text-sm font-medium">{m.chat_parent_label()}</label>
				<Input
					id={`${uid}-input`}
					bind:ref={inputRef}
					bind:value={form.query}
					role="combobox"
					autocomplete="off"
					aria-autocomplete="list"
					aria-expanded={form.suggestionsOpen}
					aria-controls={`${uid}-list`}
					aria-activedescendant={form.activeSuggestion
						? `${uid}-${form.activeSuggestion.id}`
						: undefined}
					aria-describedby={`${uid}-feedback`}
					readonly={form.submitting}
					aria-busy={form.submitting}
					placeholder={m.chat_parent_placeholder()}
					oninput={() => form.editQuery()}
					onkeydown={handleKeydown}
				/>
				{#if form.choice.kind === 'chat'}
					<p class="flex min-w-0 items-center gap-2 text-sm">
						<Check class="size-4 shrink-0" /><span class="truncate"
							>{form.selected?.title || form.choice.chatId}</span
						>
					</p>
				{:else if form.choice.kind === 'clear'}
					<p role="status" class="text-sm">{m.chat_parent_clearing()}</p>
				{/if}
				{#if form.suggestionsOpen}
					<div
						{@attach suggestionsLayer}
						id={`${uid}-list`}
						role="listbox"
						aria-label={m.chat_parent_matches()}
						class="max-h-64 overflow-y-auto rounded-md border border-border"
					>
						{#each form.suggestions as chat (chat.id)}
							<button
								type="button"
								role="option"
								id={`${uid}-${chat.id}`}
								aria-selected={form.activeSuggestion?.id === chat.id}
								tabindex="-1"
								disabled={form.submitting}
								onclick={() => form.select(chat)}
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
						{form.suggestions.length
							? m.chat_parent_match_count({ count: form.suggestions.length })
							: m.chat_parent_no_matches()}
					</p>
				{/if}
				{#if form.currentParentId}
					<Button
						variant="ghost"
						size="sm"
						disabled={form.submitting}
						onclick={() => form.clearParent()}
					>
						<Unlink class="size-4" />{m.chat_parent_remove()}
					</Button>
				{/if}
			</div>
		{/if}
		<div id={`${uid}-feedback`} aria-live="polite">
			{#if form.errorMessage}<p role="alert" class="text-sm text-destructive">
					{form.errorMessage}
				</p>{/if}
			{#if !isConnected}<p class="text-sm text-muted-foreground">{m.chat_parent_offline()}</p>{/if}
		</div>
		<Dialog.Footer>
			<Button variant="outline" disabled={form.submitting} onclick={onClose}
				>{m.sidebar_actions_cancel()}</Button
			>
			{#if form.child}
				<Button disabled={!form.canSubmit} onclick={() => void form.submit()}>
					{#if form.submitting}<Loader2
							class="size-4 animate-spin"
						/>{/if}{m.sidebar_actions_save()}
				</Button>
			{/if}
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
