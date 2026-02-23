<script lang="ts">
	import Markdown from '$lib/components/chat/Markdown.svelte';
	import type { MarkdownLinkNavigateEvent } from '$lib/components/chat/Markdown.svelte';
	import { parseFileLink } from '$lib/chat/file-link-parser';

	interface MarkdownContentProps {
		content: string;
		projectPath?: string | null;
		onFileOpen?: (filePath: string) => void;
		class?: string;
	}

	let {
		content,
		projectPath = null,
		onFileOpen,
		class: className = ''
	}: MarkdownContentProps = $props();

	function handleLinkNavigate(link: MarkdownLinkNavigateEvent): boolean | void {
		if (link.kind !== 'file' || !onFileOpen) return;
		const parsed = parseFileLink(link.rawHref, projectPath ? { projectBasePath: projectPath } : undefined);
		if (parsed.kind !== 'file') return;
		onFileOpen(parsed.relativePath);
		return true;
	}
</script>

<Markdown
	source={content}
	projectBasePath={projectPath ?? undefined}
	onLinkNavigate={handleLinkNavigate}
	class={className}
/>
