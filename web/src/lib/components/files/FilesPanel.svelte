<script lang="ts">
	import { onDestroy, untrack } from 'svelte';
	import FileTree from './FileTree.svelte';
	import FileEditorDialog from './FileEditorDialog.svelte';
	import ImageViewer from './ImageViewer.svelte';
	import * as Dialog from '$lib/components/ui/dialog';
	import { Button } from '$lib/components/ui/button';
	import { readText, saveText, getContentUrl, type FileTreeNode } from '$lib/api/files';
	import { getFileOpen } from '$lib/context';

	interface FilesPanelProps {
		projectPath: string | null;
		chatId: string | null;
	}

	let { projectPath, chatId }: FilesPanelProps = $props();

	const fileOpen = getFileOpen();

	interface SelectedFile {
		name: string;
		path: string;
		content: string;
	}

	const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'ico', 'bmp'];

	let selectedFile = $state<SelectedFile | null>(null);
	let loadingFile = $state(false);
	let editorContent = $state('');
	let hasUnsavedChanges = $state(false);
	let confirmDiscardOpen = $state(false);
	let pendingAction = $state<null | (() => void | Promise<void>)>(null);
	let pendingSaveAndContinue = $state(false);
	let guardError = $state<string | null>(null);
	let activeReadController = $state<AbortController | null>(null);
	let activeReadToken = $state(0);

	let isImage = $derived.by(() => {
		if (!selectedFile) return false;
		const ext = selectedFile.name.split('.').pop()?.toLowerCase() ?? '';
		return IMAGE_EXTENSIONS.includes(ext);
	});

	let imageUrl = $derived.by(() => {
		if (!selectedFile || !isImage) return '';
		return getContentUrl({ chatId, projectPath, filePath: selectedFile.path });
	});

	function requestReadAbort(): void {
		activeReadController?.abort();
		activeReadController = null;
	}

	function commitSelectedFile(file: SelectedFile): void {
		selectedFile = file;
		editorContent = file.content;
		hasUnsavedChanges = false;
	}

	/** Fetches file content by path and sets it as the selected file. */
	async function openFileByPath(filePath: string): Promise<void> {
		requestReadAbort();
		loadingFile = true;
		const token = ++activeReadToken;
		const controller = new AbortController();
		activeReadController = controller;
		const name = filePath.split('/').pop() || filePath;
		try {
			const data = await readText({
				chatId,
				projectPath,
				filePath,
			}, { signal: controller.signal }) as { content: string };

			if (token !== activeReadToken || controller.signal.aborted) return;

			commitSelectedFile({
				name,
				path: filePath,
				content: data.content ?? '',
			});
		} catch (error) {
			if ((error as Error).name === 'AbortError') return;
			if (token !== activeReadToken) return;
			console.error('Error loading file:', error);
			commitSelectedFile({
				name,
				path: filePath,
				content: `// Error loading file: ${(error as Error).message}`,
			});
		} finally {
			if (token === activeReadToken) {
				loadingFile = false;
				activeReadController = null;
			}
		}
	}

	async function runWithDirtyGuard(action: () => void | Promise<void>): Promise<void> {
		if (!hasUnsavedChanges || !selectedFile || isImage) {
			await action();
			return;
		}
		guardError = null;
		pendingAction = action;
		confirmDiscardOpen = true;
	}

	/** Fetches file content and opens the editor dialog. */
	async function handleFileSelect(node: FileTreeNode) {
		await runWithDirtyGuard(async () => {
			await openFileByPath(node.path);
		});
	}

	// Consumes pending file-open requests from the coordinator store.
	$effect(() => {
		const pending = fileOpen.pending;
		if (!pending || !chatId) return;
		if (pending.chatId !== chatId) return;
		untrack(() => {
			fileOpen.consumeForChat(chatId);
			void runWithDirtyGuard(async () => {
				await openFileByPath(pending.relativePath);
			});
		});
	});

	onDestroy(() => {
		requestReadAbort();
	});

	/** Opens the image viewer for image files. */
	function handleImageSelect(node: FileTreeNode) {
		void runWithDirtyGuard(async () => {
			commitSelectedFile({
				name: node.name,
				path: node.path,
				content: '',
			});
		});
	}

	/** Persists edited content to the server. */
	async function handleSave(content: string) {
		if (!selectedFile) return;
		try {
			await saveText({
				chatId,
				projectPath,
				filePath: selectedFile.path,
				content,
			});
			selectedFile = {
				...selectedFile,
				content,
			};
			editorContent = content;
			hasUnsavedChanges = false;
		} catch (error) {
			console.error('Error saving file:', error);
			throw error;
		}
	}

	function handleClose() {
		if (!selectedFile) return;
		void runWithDirtyGuard(() => {
			requestReadAbort();
			selectedFile = null;
			editorContent = '';
			hasUnsavedChanges = false;
		});
	}

	function handleEditorContentChange(content: string) {
		editorContent = content;
		const baseline = selectedFile?.content ?? '';
		hasUnsavedChanges = selectedFile != null && !isImage && content !== baseline;
	}

	function handleEditorDirtyChange(dirty: boolean) {
		hasUnsavedChanges = dirty;
	}

	async function discardAndContinue() {
		confirmDiscardOpen = false;
		guardError = null;
		const action = pendingAction;
		pendingAction = null;
		if (!action) return;
		hasUnsavedChanges = false;
		await action();
	}

	async function saveAndContinue() {
		if (!selectedFile || isImage) {
			await discardAndContinue();
			return;
		}
		pendingSaveAndContinue = true;
		guardError = null;
		try {
			await handleSave(editorContent);
			await discardAndContinue();
		} catch (error) {
			guardError = (error as Error).message || 'Failed to save file.';
		} finally {
			pendingSaveAndContinue = false;
		}
	}

	function cancelDiscardDialog() {
		confirmDiscardOpen = false;
		pendingAction = null;
		guardError = null;
	}
</script>

<div class="h-full min-h-0 flex overflow-hidden">
	<div class="flex-1 min-h-0">
		<FileTree
			{projectPath}
			{chatId}
			selectedPath={selectedFile?.path ?? null}
			onFileSelect={handleFileSelect}
			onImageSelect={handleImageSelect}
		/>
	</div>
</div>

{#if selectedFile && isImage}
	<ImageViewer src={imageUrl} alt={selectedFile.name} onClose={handleClose} />
{/if}

<FileEditorDialog
	file={!isImage ? selectedFile : null}
	onRequestClose={handleClose}
	onSave={handleSave}
	onContentChange={handleEditorContentChange}
	onDirtyChange={handleEditorDirtyChange}
/>

<Dialog.Root open={confirmDiscardOpen}>
	<Dialog.Content class="sm:max-w-md">
		<Dialog.Header>
			<Dialog.Title>Unsaved changes</Dialog.Title>
			<Dialog.Description>
				You have unsaved edits. Save before continuing?
			</Dialog.Description>
		</Dialog.Header>
		{#if guardError}
			<p class="text-sm text-destructive">{guardError}</p>
		{/if}
		<Dialog.Footer>
			<Button variant="ghost" onclick={cancelDiscardDialog}>Cancel</Button>
			<Button variant="destructive" onclick={discardAndContinue}>Discard</Button>
			<Button onclick={saveAndContinue} disabled={pendingSaveAndContinue}>
				{pendingSaveAndContinue ? 'Saving...' : 'Save and continue'}
			</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
