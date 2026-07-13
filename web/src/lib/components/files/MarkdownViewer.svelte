<script lang="ts">
	import Markdown from '$lib/components/chat/Markdown.svelte';
	import type { FileSession } from './file-session.svelte.js';
	import { getLocalSettings } from '$lib/context';

	let { session }: { session: FileSession } = $props();
	const localSettings = getLocalSettings();
	let contentElement: HTMLDivElement;
	const markdownFontSize = $derived(
		Number.parseInt(localSettings.markdownViewerFontSize, 10) || 12,
	);

	$effect(() => {
		const element = contentElement;
		if (!element) return;
		requestAnimationFrame(() => {
			element.scrollTop = session.markdownScrollTop;
		});
		return () => {
			session.markdownScrollTop = element.scrollTop;
		};
	});
</script>

<div
	bind:this={contentElement}
	class="markdown-viewer-content h-full overflow-auto bg-background p-4 text-foreground sm:p-6"
	style={`--markdown-viewer-font-size: ${markdownFontSize}px;`}
>
	<Markdown source={session.content} variant="assistant" />
</div>

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
