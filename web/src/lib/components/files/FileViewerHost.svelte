<script lang="ts">
	import * as Dialog from '$lib/components/ui/dialog';
	import { Button } from '$lib/components/ui/button';
	import { getFileViewer } from '$lib/context';
	import { FileViewerHostState } from './file-viewer-host-state.svelte';
	import FileEditorDialog from './FileEditorDialog.svelte';
	import ImageViewer from './ImageViewer.svelte';
	import MarkdownViewer from './MarkdownViewer.svelte';

	const viewer = getFileViewer();
	const host = new FileViewerHostState({
		get request() { return viewer.pending; },
		consumeRequest: () => viewer.consumePending(),
	});

	// Consumes pending open requests and delegates to host state.
	$effect(() => {
		const pending = viewer.pending;
		if (!pending) return;
		const req = viewer.consumePending();
		if (!req) return;
		void host.openFromRequest(req);
	});
</script>

{#if host.session && host.file}
	{#if host.session.mode === 'image'}
		<ImageViewer
			src={host.getImageUrl()}
			alt={host.file.name}
			onClose={() => host.closeViewer()}
		/>
	{:else if host.session.mode === 'markdown'}
		<MarkdownViewer
			filePath={host.file.path}
			content={host.file.content}
			onClose={() => host.closeViewer()}
			onEdit={() => host.switchToCodeView()}
		/>
	{:else}
		<FileEditorDialog
			file={host.toEditorFile()}
			onRequestClose={() => host.closeViewer()}
			onSave={(content) => { host.setEditorContent(content); return host.saveCurrentFile(); }}
			onContentChange={(value) => host.setEditorContent(value)}
			onDirtyChange={(dirty) => host.setDirty(dirty)}
			showMarkdownViewButton={host.isCurrentFileMarkdownInCodeMode}
			onRequestMarkdownView={() => host.switchToMarkdownView()}
		/>
	{/if}
{/if}

<Dialog.Root open={host.confirmSwitchOpen}>
	<Dialog.Content class="sm:max-w-md">
		<Dialog.Header>
			<Dialog.Title>Unsaved changes</Dialog.Title>
			<Dialog.Description>
				Save changes before continuing?
			</Dialog.Description>
		</Dialog.Header>
		{#if host.switchError}
			<p class="text-sm text-destructive">{host.switchError}</p>
		{/if}
		<Dialog.Footer>
			<Button variant="ghost" onclick={() => host.cancelSwitch()}>Cancel</Button>
			<Button variant="destructive" onclick={() => host.discardAndContinueSwitch()}>Discard</Button>
			<Button onclick={() => host.saveAndContinueSwitch()} disabled={host.pendingSave}>
				{host.pendingSave ? 'Saving...' : 'Save and continue'}
			</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
