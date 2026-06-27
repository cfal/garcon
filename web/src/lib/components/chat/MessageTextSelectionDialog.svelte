<script lang="ts">
	import * as m from '$lib/paraglide/messages.js';
	import * as Dialog from '$lib/components/ui/dialog';
	import { Button } from '$lib/components/ui/button';
	import { Textarea } from '$lib/components/ui/textarea';
	import Copy from '@lucide/svelte/icons/copy';
	import Check from '@lucide/svelte/icons/check';
	import { copyToClipboard } from '$lib/utils/clipboard';

	interface Props {
		open: boolean;
		text: string;
		onClose: () => void;
	}

	let { open, text, onClose }: Props = $props();

	let textAreaRef = $state<HTMLTextAreaElement | null>(null);
	let copied = $state(false);

	function handleOpenChange(nextOpen: boolean): void {
		if (!nextOpen) onClose();
	}

	function selectDialogText(): void {
		const input = textAreaRef;
		if (!input) return;
		input.focus();
		input.setSelectionRange(0, input.value.length);
	}

	// Selects the full message after Bits UI finishes mounting and focusing the dialog.
	$effect(() => {
		if (!open || !textAreaRef) return;
		const frame = requestAnimationFrame(selectDialogText);
		return () => cancelAnimationFrame(frame);
	});

	$effect(() => {
		if (!open) copied = false;
	});

	async function copyDialogText(event: MouseEvent): Promise<void> {
		if (!text) return;
		const container = (event.currentTarget as HTMLElement)?.closest('[role="dialog"]') ?? undefined;
		const didCopy = await copyToClipboard(text, container);
		if (!didCopy) return;
		copied = true;
		setTimeout(() => {
			copied = false;
		}, 2000);
	}
</script>

<Dialog.Root {open} onOpenChange={handleOpenChange}>
	<Dialog.Content
		class="max-h-[85vh] overflow-hidden sm:max-w-2xl"
		onOpenAutoFocus={(event) => {
			event.preventDefault();
			selectDialogText();
		}}
	>
		<Dialog.Header>
			<Dialog.Title>{m.chat_message_select_text_dialog_title()}</Dialog.Title>
			<Dialog.Description class="sr-only">
				{m.chat_message_select_text_dialog_description()}
			</Dialog.Description>
		</Dialog.Header>

		<Textarea
			bind:ref={textAreaRef}
			readonly
			rows={12}
			value={text}
			aria-label={m.chat_message_select_text_dialog_title()}
			class="chat-mobile-compact-textarea max-h-[60vh] min-h-48 resize-none overflow-y-auto font-mono text-base sm:text-sm"
		/>

		<Dialog.Footer>
			<Button variant="outline" onclick={onClose}>{m.sidebar_actions_cancel()}</Button>
			<Button onclick={copyDialogText} variant={copied ? 'outline' : 'default'}>
				{#if copied}
					<Check class="size-4" />
					{m.chat_message_select_text_copied()}
				{:else}
					<Copy class="size-4" />
					{m.chat_message_select_text_copy()}
				{/if}
			</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
