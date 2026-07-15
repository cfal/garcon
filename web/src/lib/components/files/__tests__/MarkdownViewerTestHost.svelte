<script lang="ts">
	import { setLocalSettings } from '$lib/context';
	import type { FileSession } from '$lib/files/sessions/file-session.svelte.js';
	import MarkdownViewer from '../MarkdownViewer.svelte';

	let { session }: { session: FileSession } = $props();

	setLocalSettings({ markdownViewerFontSize: '14' } as never);
</script>

<MarkdownViewer {session} />
