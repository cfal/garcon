<script lang="ts">
	import * as m from '$lib/paraglide/messages.js';
	import * as Dialog from '$lib/components/ui/dialog';
	import { Button } from '$lib/components/ui/button';
	import Copy from '@lucide/svelte/icons/copy';
	import Check from '@lucide/svelte/icons/check';
	import TextSelect from '@lucide/svelte/icons/text-select';
	import { copyToClipboard } from '$lib/utils/clipboard';

	interface Props {
		open: boolean;
		text: string;
		onClose: () => void;
	}

	let { open, text, onClose }: Props = $props();

	let textSurfaceRef = $state<HTMLElement | null>(null);
	let copied = $state(false);

	function handleOpenChange(nextOpen: boolean): void {
		if (!nextOpen) onClose();
	}

	$effect(() => {
		if (!open) copied = false;
	});

	function selectAllDialogText(): void {
		const surface = textSurfaceRef;
		if (!surface || typeof window === 'undefined') return;
		const selection = window.getSelection();
		if (!selection) return;
		const range = document.createRange();
		range.selectNodeContents(surface);
		selection.removeAllRanges();
		selection.addRange(range);
	}

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
	<Dialog.Content class="max-h-[85vh] overflow-hidden sm:max-w-2xl">
		<Dialog.Header>
			<Dialog.Title>{m.chat_message_select_text_dialog_title()}</Dialog.Title>
			<Dialog.Description class="sr-only">
				{m.chat_message_select_text_dialog_description()}
			</Dialog.Description>
		</Dialog.Header>

		<pre
			bind:this={textSurfaceRef}
			role="region"
			aria-label={m.chat_message_select_text_dialog_title()}
			class="max-h-[60vh] min-h-48 select-text overflow-y-auto whitespace-pre-wrap break-words rounded-md border border-input bg-background p-3 font-mono text-sm leading-relaxed text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">{text}</pre>

		<Dialog.Footer>
			<Button variant="outline" onclick={onClose}>{m.sidebar_actions_cancel()}</Button>
			<Button variant="outline" onclick={selectAllDialogText}>
				<TextSelect class="size-4" />
				{m.chat_message_select_text_select_all()}
			</Button>
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
