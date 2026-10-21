<script lang="ts">
	import { untrack } from 'svelte';
	import { setFileImages } from '$lib/context/file-images-context.js';
	import type { FileImageCache } from '$lib/files/images/file-image-cache.svelte.js';
	import type { ResolveMarkdownImageFile } from '$lib/chat/file-links/file-link-resolver.js';
	import Markdown from '../Markdown.svelte';
	let {
		cache,
		source,
		resolveImageFile,
	}: {
		cache: FileImageCache;
		source: string;
		resolveImageFile: ResolveMarkdownImageFile;
	} = $props();
	setFileImages(untrack(() => cache));
</script>

<Markdown {source} {resolveImageFile} />
