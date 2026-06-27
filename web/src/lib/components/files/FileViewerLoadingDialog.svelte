<script lang="ts">
	import * as Dialog from '$lib/components/ui/dialog';
	import { Button } from '$lib/components/ui/button';
	import type { ActiveFileViewerSession } from '$lib/stores/file-viewer.svelte';
	import Loader2 from '@lucide/svelte/icons/loader-2';
	import TriangleAlert from '@lucide/svelte/icons/triangle-alert';
	import X from '@lucide/svelte/icons/x';
	import * as m from '$lib/paraglide/messages.js';

	interface Props {
		session: ActiveFileViewerSession;
		message?: string;
		error?: string | null;
		onClose: () => void;
	}

	let { session, message, error = null, onClose }: Props = $props();

	const fileName = $derived(session.relativePath.split('/').pop() ?? session.relativePath);
	const statusMessage = $derived(message ?? m.file_viewer_opening_file());
	const title = $derived(error ? m.file_viewer_open_failed() : m.file_viewer_opening_title());

	function handleOpenChange(open: boolean): void {
		if (!open) onClose();
	}
</script>

<Dialog.Root open={true} onOpenChange={handleOpenChange}>
	<Dialog.Content
		class="flex h-dvh w-full max-w-full flex-col gap-0 overflow-hidden rounded-none border-0 p-0 sm:h-[85vh] sm:max-w-5xl sm:rounded-lg sm:border"
		showCloseButton={false}
	>
		<div
			class="flex items-center justify-between border-b border-border bg-card p-3 text-foreground"
		>
			<div class="min-w-0">
				<Dialog.Title class="truncate text-base font-medium leading-normal">
					{fileName}
				</Dialog.Title>
				<Dialog.Description class="truncate text-xs text-muted-foreground">
					{session.relativePath}
				</Dialog.Description>
			</div>
			<Button
				variant="ghost"
				size="icon-sm"
				onclick={onClose}
				title={m.editor_actions_close()}
				aria-label={m.editor_actions_close()}
			>
				<X class="h-4 w-4" />
			</Button>
		</div>

		<div class="flex flex-1 items-center justify-center bg-background p-6 text-foreground">
			<div class="max-w-md text-center" aria-live="polite">
				{#if error}
					<TriangleAlert class="mx-auto mb-3 h-8 w-8 text-destructive" />
					<p class="text-sm font-medium">{title}</p>
					<p class="mt-2 break-words text-sm text-muted-foreground">{error}</p>
				{:else}
					<Loader2 class="mx-auto mb-3 h-8 w-8 animate-spin text-interactive-accent" />
					<p class="text-sm font-medium">{statusMessage}</p>
					<p class="mt-2 truncate text-xs text-muted-foreground">{session.relativePath}</p>
				{/if}
			</div>
		</div>
	</Dialog.Content>
</Dialog.Root>
