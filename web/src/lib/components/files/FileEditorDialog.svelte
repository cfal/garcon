<script lang="ts">
	import * as Dialog from '$lib/components/ui/dialog';
	import CodeEditor from './CodeEditor.svelte';
	import { getLocalSettings, getNotifications } from '$lib/context';
	import * as m from '$lib/paraglide/messages.js';

	const localSettings = getLocalSettings();
	const notifications = getNotifications();

	interface SelectedFile {
		name: string;
		path: string;
		content: string;
		oldContent?: string | null;
		showDiff?: boolean;
		line?: number;
		col?: number;
	}

	interface FileEditorDialogProps {
		file: SelectedFile | null;
		onRequestClose: () => void;
		onSave?: (content: string) => Promise<void> | void;
		onContentChange?: (content: string) => void;
		onDirtyChange?: (dirty: boolean) => void;
		showMarkdownViewButton?: boolean;
		onRequestMarkdownView?: () => void;
	}

	let {
		file,
		onRequestClose,
		onSave,
		onContentChange,
		onDirtyChange,
		showMarkdownViewButton = false,
		onRequestMarkdownView,
	}: FileEditorDialogProps = $props();

	let maximized = $state(false);

	const BASE_CLASS =
		'flex flex-col h-dvh w-full max-w-full sm:max-w-full rounded-none border-0 p-0 gap-0 overflow-hidden';
	const WINDOWED_CLASS =
		'flex flex-col h-dvh w-full max-w-full rounded-none border-0 p-0 gap-0 overflow-hidden sm:h-[85vh] sm:max-w-5xl sm:rounded-lg sm:border';

	let contentClass = $derived(maximized ? BASE_CLASS : WINDOWED_CLASS);

	function handleOpenChange(open: boolean) {
		if (!open) onRequestClose();
	}

	function toggleMaximize() {
		maximized = !maximized;
	}
</script>

<Dialog.Root open={file !== null} onOpenChange={handleOpenChange}>
	<Dialog.Content class={contentClass} showCloseButton={false}>
		{#if file}
			<CodeEditor
				content={file.content}
				filePath={file.path}
				oldContent={file.oldContent ?? null}
				showDiff={Boolean(file.showDiff && file.oldContent != null)}
				initialLine={file.line}
				initialColumn={file.col}
				wordWrap={localSettings.codeEditorWordWrap}
				showLineNumbers={localSettings.codeEditorLineNumbers}
				fontSize={parseInt(localSettings.codeEditorFontSize, 10)}
				onClose={onRequestClose}
				{onSave}
				onChange={onContentChange}
				{onDirtyChange}
				isSidebar={true}
				isExpanded={maximized}
				onToggleExpand={toggleMaximize}
				{showMarkdownViewButton}
				{onRequestMarkdownView}
				onSaveError={() => notifications.error(m.notifications_save_file_failed())}
			/>
		{/if}
	</Dialog.Content>
</Dialog.Root>
