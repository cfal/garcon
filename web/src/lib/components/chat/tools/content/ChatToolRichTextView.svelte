<script lang="ts">
	import type { ResolveMarkdownImageFile } from '$lib/chat/file-links/file-link-resolver.js';
	import Markdown from '$lib/components/rich-text/Markdown.svelte';
	import type { MarkdownLinkNavigateEvent } from '$lib/components/rich-text/Markdown.svelte';
	import type { ResolveChatReference } from '$lib/chat/transcript/chat-reference.js';

	interface MarkdownContentProps {
		content: string;
		projectBasePath?: string | null;
		chatProjectPath?: string | null;
		onFileOpen?: (filePath: string) => void;
		resolveChatReference?: ResolveChatReference;
		resolveImageFile?: ResolveMarkdownImageFile;
		acquireTransientActivity?: (close: () => void) => () => void;
		class?: string;
	}

	let {
		content,
		projectBasePath = null,
		chatProjectPath = null,
		onFileOpen,
		resolveChatReference,
		resolveImageFile,
		acquireTransientActivity,
		class: className = '',
	}: MarkdownContentProps = $props();

	const fileLinkBasePath = $derived(projectBasePath ?? chatProjectPath);

	function handleLinkNavigate(link: MarkdownLinkNavigateEvent): boolean | void {
		if (link.kind !== 'file' || !onFileOpen) return;
		onFileOpen(link.rawHref);
		return true;
	}
</script>

<Markdown
	source={content}
	fileLinkBasePath={fileLinkBasePath ?? undefined}
	onLinkNavigate={handleLinkNavigate}
	{resolveImageFile}
	{resolveChatReference}
	chatReferencePolicy="explicit"
	class={className}
	{acquireTransientActivity}
/>
