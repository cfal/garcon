<script lang="ts">
	import Markdown, { type MarkdownLinkNavigateEvent } from '$lib/components/chat/Markdown.svelte';
	import { resolveFileLinkFromFile } from '$lib/chat/file-links/file-link-resolver.js';
	import type { FileSession } from '$lib/files/sessions/file-session.svelte.js';
	import { getFileSessions, getLocalSettings } from '$lib/context';
	import type { PresentationHostId } from '$lib/workspace/surface-types.js';

	let { session, presentation }: { session: FileSession; presentation: PresentationHostId } =
		$props();
	const files = getFileSessions();
	const localSettings = getLocalSettings();
	let contentElement: HTMLDivElement;
	const markdownFontSize = $derived(
		Number.parseInt(localSettings.markdownViewerFontSize, 10) || 12,
	);

	$effect(() => {
		const element = contentElement;
		if (!element) return;
		let restored = false;
		const frame = requestAnimationFrame(() => {
			element.scrollLeft = session.markdownScrollLeft;
			element.scrollTop = session.markdownScrollTop;
			restored = true;
		});
		return () => {
			cancelAnimationFrame(frame);
			if (restored) captureScroll(element);
		};
	});

	function captureScroll(element: HTMLDivElement): void {
		session.markdownScrollLeft = element.scrollLeft;
		session.markdownScrollTop = element.scrollTop;
	}

	function navigateFileLink(link: MarkdownLinkNavigateEvent): boolean {
		if (link.kind !== 'file') return false;
		const target = resolveFileLinkFromFile(link.rawHref, {
			fileRootPath: session.canonicalFileRootPath,
			sourceFilePath: session.relativePath,
		});
		if (!target) return false;
		void files.open({
			...target,
			mode: 'auto',
			origin: presentation,
			reason: 'user-open',
		});
		return true;
	}
</script>

<div
	bind:this={contentElement}
	data-surface-primary
	tabindex="-1"
	role="region"
	aria-label={session.fileName}
	class="markdown-viewer-content h-full overflow-auto bg-background p-4 text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring sm:p-6"
	style={`--markdown-viewer-font-size: ${markdownFontSize}px;`}
	onscroll={(event) => captureScroll(event.currentTarget)}
>
	<Markdown
		source={session.content}
		variant="assistant"
		fileLinkBasePath={session.canonicalFileRootPath}
		onLinkNavigate={navigateFileLink}
	/>
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
