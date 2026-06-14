<script module lang="ts">
	type FileEditorDialogModule = typeof import('./FileEditorDialog.svelte');
	type ImageViewerModule = typeof import('./ImageViewer.svelte');
	type MarkdownViewerModule = typeof import('./MarkdownViewer.svelte');

	let fileEditorDialogPromise: Promise<FileEditorDialogModule> | null = null;
	let imageViewerPromise: Promise<ImageViewerModule> | null = null;
	let markdownViewerPromise: Promise<MarkdownViewerModule> | null = null;

	function loadFileEditorDialog(): Promise<FileEditorDialogModule> {
		fileEditorDialogPromise ??= import('./FileEditorDialog.svelte');
		return fileEditorDialogPromise;
	}

	function loadImageViewer(): Promise<ImageViewerModule> {
		imageViewerPromise ??= import('./ImageViewer.svelte');
		return imageViewerPromise;
	}

	function loadMarkdownViewer(): Promise<MarkdownViewerModule> {
		markdownViewerPromise ??= import('./MarkdownViewer.svelte');
		return markdownViewerPromise;
	}
</script>

<script lang="ts">
	import * as Dialog from '$lib/components/ui/dialog';
	import { Button } from '$lib/components/ui/button';
	import { getFileViewer } from '$lib/context';
	import { FileViewerHostState } from './file-viewer-host-state.svelte';

	const viewer = getFileViewer();
	const host = new FileViewerHostState({
		get request() {
			return viewer.pending;
		},
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
		{#await loadImageViewer() then { default: ImageViewer }}
			<ImageViewer
				src={host.getImageUrl()}
				alt={host.file.name}
				onClose={() => host.closeViewer()}
			/>
		{/await}
	{:else if host.session.mode === 'markdown'}
		{#await loadMarkdownViewer() then { default: MarkdownViewer }}
			<MarkdownViewer
				filePath={host.file.path}
				content={host.file.content}
				onClose={() => host.closeViewer()}
				onEdit={() => host.switchToCodeView()}
			/>
		{/await}
	{:else}
		{#await loadFileEditorDialog() then { default: FileEditorDialog }}
			<FileEditorDialog
				file={host.toEditorFile()}
				onRequestClose={() => host.closeViewer()}
				onSave={(content) => {
					host.setEditorContent(content);
					return host.saveCurrentFile();
				}}
				onContentChange={(value) => host.setEditorContent(value)}
				onDirtyChange={(dirty) => host.setDirty(dirty)}
				showMarkdownViewButton={host.isCurrentFileMarkdownInCodeMode}
				onRequestMarkdownView={() => host.switchToMarkdownView()}
			/>
		{/await}
	{/if}
{/if}

<Dialog.Root open={host.confirmSwitchOpen}>
	<Dialog.Content class="sm:max-w-md">
		<Dialog.Header>
			<Dialog.Title>Unsaved changes</Dialog.Title>
			<Dialog.Description>Save changes before continuing?</Dialog.Description>
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
