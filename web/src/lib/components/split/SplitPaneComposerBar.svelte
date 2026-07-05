<script lang="ts">
	import { onDestroy } from 'svelte';
	import SendHorizontal from '@lucide/svelte/icons/send-horizontal';
	import * as m from '$lib/paraglide/messages.js';
	import {
		chatDraftStorageKey,
		getLocalStorageItem,
		removeLocalStorageItem,
		setLocalStorageItem,
	} from '$lib/utils/local-persistence';

	interface SplitPaneComposerBarProps {
		chatId: string;
		title: string;
		onFocus: () => void;
	}

	let { chatId, title, onFocus }: SplitPaneComposerBarProps = $props();

	let draftText = $state('');
	let focusTimer: ReturnType<typeof setTimeout> | null = null;

	function loadDraft(id: string): void {
		draftText = getLocalStorageItem(chatDraftStorageKey(id)) ?? '';
	}

	$effect(() => {
		loadDraft(chatId);
	});

	function persistDraft(): void {
		const key = chatDraftStorageKey(chatId);
		if (draftText.trim()) {
			setLocalStorageItem(key, draftText);
		} else {
			removeLocalStorageItem(key);
		}
	}

	function clearFocusTimer(): void {
		if (!focusTimer) return;
		clearTimeout(focusTimer);
		focusTimer = null;
	}

	function promoteFocus(): void {
		clearFocusTimer();
		onFocus();
	}

	function scheduleFocusPromotion(): void {
		clearFocusTimer();
		focusTimer = setTimeout(() => {
			focusTimer = null;
			onFocus();
		}, 100);
	}

	function handleInput(event: Event): void {
		draftText = (event.currentTarget as HTMLTextAreaElement).value;
		persistDraft();
		promoteFocus();
	}

	onDestroy(clearFocusTimer);
</script>

<div class="flex-shrink-0 border-t border-border/40 bg-background/95 p-2">
	<div class="rounded-xl border border-border bg-card shadow-sm">
		<textarea
			bind:value={draftText}
			rows="1"
			class="block w-full resize-none bg-transparent px-3 py-2 text-sm leading-5 text-foreground outline-none placeholder:text-muted-foreground/80"
			placeholder={m.chat_composer_reply_placeholder()}
			aria-label={m.chat_pane_focus_composer({ title })}
			onpointerdown={(event) => event.stopPropagation()}
			onclick={(event) => event.stopPropagation()}
			onfocus={scheduleFocusPromotion}
			oninput={handleInput}
			onkeydown={(event) => {
				if (event.key === 'Escape') {
					event.preventDefault();
					event.stopPropagation();
					(event.currentTarget as HTMLTextAreaElement).blur();
				}
			}}></textarea>
		<div class="flex items-center justify-end border-t border-border/40 px-2 py-1.5">
			<div
				class="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground/70"
				aria-hidden="true"
			>
				<SendHorizontal class="h-3.5 w-3.5" />
			</div>
		</div>
	</div>
</div>
