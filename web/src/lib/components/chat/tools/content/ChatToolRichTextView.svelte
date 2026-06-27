<script lang="ts">
	import Markdown from '$lib/components/chat/Markdown.svelte';
	import type { MarkdownLinkNavigateEvent } from '$lib/components/chat/Markdown.svelte';

	interface MarkdownContentProps {
		content: string;
		projectBasePath?: string | null;
		chatProjectPath?: string | null;
		onFileOpen?: (filePath: string) => void;
		class?: string;
	}

	let {
		content,
		projectBasePath = null,
		chatProjectPath = null,
		onFileOpen,
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
	class={className}
/>
