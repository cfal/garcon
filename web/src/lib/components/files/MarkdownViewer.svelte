<script lang="ts">
	import * as Dialog from '$lib/components/ui/dialog';
	import { Button } from '$lib/components/ui/button';
	import X from '@lucide/svelte/icons/x';
	import Pencil from '@lucide/svelte/icons/pencil';
	import Maximize2 from '@lucide/svelte/icons/maximize-2';
	import Minimize2 from '@lucide/svelte/icons/minimize-2';
	import Markdown from '$lib/components/chat/Markdown.svelte';
	import MarkdownViewerSettingsMenu from './MarkdownViewerSettingsMenu.svelte';
	import { getPreferences } from '$lib/context';
	import * as m from '$lib/paraglide/messages.js';

	interface MarkdownViewerProps {
		filePath: string;
		content: string;
		onClose: () => void;
		onEdit: () => void;
	}

	const preferences = getPreferences();
	let { filePath, content, onClose, onEdit }: MarkdownViewerProps = $props();
	let maximized = $state(false);

	const BASE_CLASS = 'flex flex-col h-dvh w-full max-w-full sm:max-w-full rounded-none border-0 p-0 gap-0 overflow-hidden';
	const WINDOWED_CLASS = 'flex flex-col h-dvh w-full max-w-full rounded-none border-0 p-0 gap-0 overflow-hidden sm:h-[85vh] sm:max-w-5xl sm:rounded-lg sm:border';

	let contentClass = $derived(maximized ? BASE_CLASS : WINDOWED_CLASS);
	let markdownFontSize = $derived(parseInt(preferences.markdownViewerFontSize, 10) || 12);

	function handleOpenChange(open: boolean): void {
		if (!open) onClose();
	}
</script>

<Dialog.Root open={true} onOpenChange={handleOpenChange}>
	<Dialog.Content class={contentClass} showCloseButton={false}>
		<div class="flex items-center justify-between p-3 border-b border-border bg-card text-foreground">
			<div class="min-w-0">
				<h3 class="font-medium truncate">{filePath.split('/').pop() ?? filePath}</h3>
				<p class="text-xs text-muted-foreground truncate">{filePath}</p>
			</div>
			<div class="flex items-center gap-1">
				<Button variant="ghost" size="sm" onclick={onEdit}>
					<Pencil class="w-4 h-4" />
					Edit
				</Button>
				<MarkdownViewerSettingsMenu />
				<Button
					variant="ghost"
					size="icon-sm"
					onclick={() => (maximized = !maximized)}
					title={maximized ? m.editor_actions_collapse() : m.editor_actions_expand()}
				>
					{#if maximized}
						<Minimize2 class="w-4 h-4" />
					{:else}
						<Maximize2 class="w-4 h-4" />
					{/if}
				</Button>
				<Button variant="ghost" size="icon-sm" onclick={onClose} title={m.editor_actions_close()}>
					<X class="w-4 h-4" />
				</Button>
			</div>
		</div>

		<div
			class="markdown-viewer-content flex-1 overflow-auto bg-background text-foreground p-4 sm:p-6"
			style={`--markdown-viewer-font-size: ${markdownFontSize}px;`}
		>
			<Markdown source={content} variant="assistant" />
		</div>
	</Dialog.Content>
</Dialog.Root>

<style>
	:global(.markdown-viewer-content .markdown-body),
	:global(.markdown-viewer-content .markdown-body p),
	:global(.markdown-viewer-content .markdown-body li),
	:global(.markdown-viewer-content .markdown-body code),
	:global(.markdown-viewer-content .markdown-body pre),
	:global(.markdown-viewer-content .markdown-body blockquote),
	:global(.markdown-viewer-content .markdown-body a),
	:global(.markdown-viewer-content .markdown-body table),
	:global(.markdown-viewer-content .markdown-body th),
	:global(.markdown-viewer-content .markdown-body td) {
		font-size: var(--markdown-viewer-font-size);
	}
</style>
