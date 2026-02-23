<script lang="ts">
	import * as Dialog from '$lib/components/ui/dialog';
	import CodeEditor from './CodeEditor.svelte';
	import { getPreferences } from '$lib/context';

	const preferences = getPreferences();

	interface SelectedFile {
		name: string;
		path: string;
		content: string;
		oldContent?: string | null;
		showDiff?: boolean;
	}

	interface FileEditorDialogProps {
		file: SelectedFile | null;
		onRequestClose: () => void;
		onSave?: (content: string) => Promise<void> | void;
		onContentChange?: (content: string) => void;
		onDirtyChange?: (dirty: boolean) => void;
	}

	let { file, onRequestClose, onSave, onContentChange, onDirtyChange }: FileEditorDialogProps = $props();

	let maximized = $state(false);

	const BASE_CLASS = 'flex flex-col h-dvh w-full max-w-full sm:max-w-full rounded-none border-0 p-0 gap-0 overflow-hidden';
	const WINDOWED_CLASS = 'flex flex-col h-dvh w-full max-w-full rounded-none border-0 p-0 gap-0 overflow-hidden sm:h-[85vh] sm:max-w-5xl sm:rounded-lg sm:border';

	let contentClass = $derived(maximized ? BASE_CLASS : WINDOWED_CLASS);

	function handleOpenChange(open: boolean) {
		if (!open) onRequestClose();
	}

	function toggleMaximize() {
		maximized = !maximized;
	}
</script>

<Dialog.Root open={file !== null} onOpenChange={handleOpenChange}>
	<Dialog.Content
		class={contentClass}
		showCloseButton={false}
	>
		{#if file}
				<CodeEditor
					content={file.content}
					filePath={file.path}
				oldContent={file.oldContent ?? null}
				showDiff={Boolean(file.showDiff && file.oldContent != null)}
				wordWrap={preferences.codeEditorWordWrap}
				showLineNumbers={preferences.codeEditorLineNumbers}
				fontSize={parseInt(preferences.codeEditorFontSize, 10)}
					onClose={onRequestClose}
					{onSave}
					onChange={onContentChange}
					{onDirtyChange}
					isSidebar={true}
					isExpanded={maximized}
					onToggleExpand={toggleMaximize}
				/>
		{/if}
	</Dialog.Content>
</Dialog.Root>
