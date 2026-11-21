<script lang="ts">
	import Copy from '@lucide/svelte/icons/copy';
	import Download from '@lucide/svelte/icons/download';
	import * as Dialog from '$lib/components/ui/dialog';
	import { Button } from '$lib/components/ui/button';
	import { copyToClipboard } from '$lib/utils/clipboard';
	import * as m from '$lib/paraglide/messages.js';

	let { source, filename, onClose }: { source: string; filename: string; onClose: () => void } =
		$props();
	let container = $state<HTMLDivElement>();
	let copied = $state<boolean | null>(null);

	async function copy() {
		copied = await copyToClipboard(source, container);
	}

	function download() {
		const url = URL.createObjectURL(new Blob([source], { type: 'application/yaml' }));
		const link = document.createElement('a');
		link.href = url;
		link.download = filename;
		link.click();
		setTimeout(() => URL.revokeObjectURL(url), 1_000);
	}
</script>

<Dialog.Root
	open
	onOpenChange={(open) => {
		if (!open) onClose();
	}}
>
	<Dialog.Content class="max-h-[85dvh] min-w-0 overflow-auto sm:max-w-2xl">
		<Dialog.Header>
			<Dialog.Title>{m.workflow_studio_share_yaml()}</Dialog.Title>
			<Dialog.Description>{m.workflow_studio_share_literals()}</Dialog.Description>
		</Dialog.Header>
		<div bind:this={container} class="min-w-0 space-y-3">
			<pre
				class="max-h-[45dvh] overflow-auto whitespace-pre-wrap wrap-anywhere bg-muted p-3 text-xs">{source}</pre>
			<div class="flex flex-wrap gap-2">
				<Button variant="outline" onclick={copy}
					><Copy class="size-4" /> {m.workflow_studio_copy_yaml()}</Button
				>
				<Button onclick={download}
					><Download class="size-4" /> {m.workflow_studio_download_yaml()}</Button
				>
			</div>
			{#if copied !== null}<p role="status" class="text-sm">
					{copied ? m.workflow_studio_copied() : m.workflow_studio_copy_failed()}
				</p>{/if}
		</div>
	</Dialog.Content>
</Dialog.Root>
