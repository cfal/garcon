<script lang="ts">
	import { setExternalLinkPolicy } from '$lib/context';
	import type { ExternalLinkPolicy } from '$lib/browser/external-link-policy.js';
	import Markdown from '../Markdown.svelte';

	let { source, policy }: { source: string; policy: ExternalLinkPolicy } = $props();
	setExternalLinkPolicy({ openExternalLink: (href) => policy.openExternalLink(href) });
</script>

<Markdown {source} />
