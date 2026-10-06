<script lang="ts">
	import * as Dialog from '$lib/components/ui/dialog';
	import { Button } from '$lib/components/ui/button';
	import X from '@lucide/svelte/icons/x';
	import * as m from '$lib/paraglide/messages.js';

	interface Props {
		title: string;
		description: string;
		onClose: () => void;
		closeDisabled?: boolean;
	}

	let { title, description, onClose, closeDisabled = false }: Props = $props();
</script>

<Dialog.Header
	class="shrink-0 flex-row items-start justify-between gap-3 border-b border-border bg-background px-4 py-3 text-start sm:px-6 sm:py-4"
>
	<div class="min-w-0 space-y-1">
		<Dialog.Title class="text-lg font-semibold leading-6">{title}</Dialog.Title>
		<Dialog.Description class="text-sm leading-5">{description}</Dialog.Description>
	</div>
	<Button
		variant="ghost"
		size="icon"
		class="size-11 shrink-0"
		aria-label={m.common_close()}
		disabled={closeDisabled}
		onclick={onClose}
	>
		<X class="size-5" />
	</Button>
</Dialog.Header>
